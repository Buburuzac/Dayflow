// Chat orchestration (ChatService.swift): conversation state, prompt assembly per provider,
// stream event handling, 50 ms coalesced UI flushes, metadata parsing, memory and persistence.
// No Electron imports: dependencies are injected by src/main/features/chat.ts.

import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type {
  ActiveTurnSnapshot,
  ChatEvent,
  ChatMemory,
  ChatMessage,
  ChatSendRequest,
  ChatStage,
  ChatStatus,
  ChatTurnResult,
  ConversationDetail,
  ToolRun,
} from '../../shared/chat-types.ts'
import type { Category, ProviderId, Settings } from '../../shared/types.ts'
import {
  conversationTitle,
  isMissingSessionError,
  joinAfterTool,
  parseMetadata,
  RECENT_SUGGESTIONS_SENT,
  toolSummary,
  updateSuggestionHistory,
  visibleStreamingText,
} from './metadata.ts'
import { buildFlatPrompt, buildSystemInstruction, cliSystemPrompt, geminiSystemPrompt, type HistoryTurn, type PromptContext } from './prompts.ts'
import { CancelledError, type Emit, killAllChildren, type StreamEvent } from './runner.ts'
import { type CliConfig, type McpLaunch, runClaude, runCodex } from './runner-cli.ts'
import { GeminiChatRunner } from './runner-gemini.ts'
import { OpenAIChatRunner } from './runner-openai.ts'
import { ChatStorage } from './storage.ts'
import { executeTool } from './tools.ts'

export const CHAT_REQUIRED_HOURS = 10
export const BATCH_MINUTES = 15
export const FLUSH_MS = 50

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  gemini: 'Gemini',
  openai_compatible: 'Local model',
  claude_cli: 'Claude',
  codex_cli: 'Codex',
}

export interface ChatServiceDeps {
  db: DatabaseSync
  getSettings: () => Settings
  getSecret: (key: 'geminiApiKey' | 'openaiApiKey') => string
  broadcast: (ev: ChatEvent) => void
  /** <dataDir>/chatcli */
  cliCwd: string
  mcp: McpLaunch
  now?: () => Date
}

export interface ConversationState {
  id: string
  createdAt: number
  provider: ProviderId
  messages: ChatMessage[]
  history: HistoryTurn[]
  sessionId: string | null
  suggestionHistory: string[]
  /** Set by delete(): a running turn must not write the conversation back. */
  deleted?: boolean
}

/** A turn in flight: its abort handle plus the live state a remounted view needs. */
interface ActiveTurn {
  controller: AbortController
  snapshot: ActiveTurnSnapshot
}

/** send() rejects with this while another turn on the same conversation is still running. */
export const TURN_IN_PROGRESS_ERROR = 'A reply is still being generated for this conversation. Wait for it or stop it first.'

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type EventBody = DistributiveOmit<ChatEvent, 'turnId'>

const nowSec = () => Math.floor(Date.now() / 1000)

function cliOnPath(command: string): boolean {
  if (isAbsolute(command)) return existsSync(command)
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], { windowsHide: true, encoding: 'utf8' })
  return r.status === 0 && Boolean(r.stdout?.trim())
}

export class ChatService {
  readonly storage: ChatStorage
  private readonly deps: ChatServiceDeps
  private readonly conversations = new Map<string, ConversationState>()
  /** Running turns by turnId (insertion order = start order) */
  private readonly active = new Map<string, ActiveTurn>()
  /** conversationId -> turnId of its running turn */
  private readonly activeByConversation = new Map<string, string>()
  private disposed = false
  private cliCache = new Map<string, { ok: boolean; at: number }>()

  constructor(deps: ChatServiceDeps) {
    this.deps = deps
    this.storage = new ChatStorage(deps.db)
  }

  // ---- status / gate ----

  private cliAvailable(command: string): boolean {
    const c = this.cliCache.get(command)
    if (c && Date.now() - c.at < 60_000) return c.ok
    const ok = cliOnPath(command)
    this.cliCache.set(command, { ok, at: Date.now() })
    return ok
  }

  availability(s: Settings): { available: boolean; message: string } {
    switch (s.provider) {
      case 'gemini':
        return this.deps.getSecret('geminiApiKey')
          ? { available: true, message: '' }
          : { available: false, message: 'Gemini is not configured. Add your Gemini API key in Settings > Providers.' }
      case 'openai_compatible':
        return s.openaiBaseUrl.trim() && s.openaiModel.trim()
          ? { available: true, message: '' }
          : { available: false, message: 'Set the local server URL and model in Settings.' }
      case 'claude_cli':
        return this.cliAvailable(s.claudeCommand || 'claude')
          ? { available: true, message: '' }
          : { available: false, message: "Claude CLI not found. Please install it and run 'claude login' in a terminal." }
      case 'codex_cli':
        return this.cliAvailable(s.codexCommand || 'codex')
          ? { available: true, message: '' }
          : { available: false, message: "Codex CLI not found. Please install it and run 'codex login' in a terminal." }
    }
  }

  status(): ChatStatus {
    const s = this.deps.getSettings()
    const a = this.availability(s)
    const analyzedHours = (this.storage.analyzedBatchCount() * BATCH_MINUTES) / 60
    return {
      provider: s.provider,
      providerLabel: PROVIDER_LABELS[s.provider],
      available: a.available,
      availabilityMessage: a.message,
      analyzedHours,
      requiredHours: CHAT_REQUIRED_HOURS,
      hasEnoughData: analyzedHours >= CHAT_REQUIRED_HOURS,
      betaAccepted: this.storage.getState('hasChatBetaAccepted') === '1',
      activeTurn: this.latestActiveSnapshot(),
    }
  }

  private latestActiveSnapshot(): ActiveTurnSnapshot | null {
    let last: ActiveTurn | undefined
    for (const t of this.active.values()) last = t
    return last ? cloneSnapshot(last.snapshot) : null
  }

  /** Live state of the running turn on `conversationId`, if any. */
  activeTurnFor(conversationId: string): ActiveTurnSnapshot | null {
    const tid = this.activeByConversation.get(conversationId)
    const t = tid ? this.active.get(tid) : undefined
    return t ? cloneSnapshot(t.snapshot) : null
  }

  acceptBeta(): ChatStatus {
    this.storage.setState('hasChatBetaAccepted', '1')
    return this.status()
  }

  // ---- history ----

  list() {
    return this.storage.listConversations()
  }

  load(id: string): ConversationDetail | null {
    // A running turn owns the cached state (its newest messages are not saved yet): never replace it.
    const running = this.activeTurnFor(id)
    const cached = this.conversations.get(id)
    if (running && cached) {
      return {
        id: cached.id,
        title: conversationTitle(cached.messages.find((m) => m.role === 'user')?.content),
        provider: cached.provider,
        createdAt: cached.createdAt,
        updatedAt: nowSec(),
        messages: cached.messages.map((m) => ({ ...m })),
        activeTurn: running,
      }
    }
    const c = this.storage.loadConversation(id)
    if (!c) return null
    this.conversations.set(id, {
      id: c.id,
      createdAt: c.createdAt,
      provider: c.provider,
      messages: c.messages,
      history: c.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      sessionId: c.cliSessionId,
      suggestionHistory: [],
    })
    const { cliSessionId: _s, ...detail } = c
    return { ...detail, activeTurn: null }
  }

  delete(id: string): void {
    const c = this.conversations.get(id)
    if (c) c.deleted = true
    const tid = this.activeByConversation.get(id)
    if (tid) this.active.get(tid)?.controller.abort()
    this.conversations.delete(id)
    this.storage.deleteConversation(id)
  }

  // ---- memory ----

  getMemory(): ChatMemory {
    return this.storage.loadMemory()
  }

  /** Saves memory; when it changed, every cached CLI session is dropped so the next turn rebuilds the prompt. */
  saveMemory(text: string): ChatMemory {
    const old = this.storage.loadMemory().text
    const m = this.storage.saveMemory(text)
    if (m.text !== old) this.resetSessions()
    return m
  }

  clearMemory(): ChatMemory {
    const old = this.storage.loadMemory().text
    const m = this.storage.clearMemory()
    if (old) this.resetSessions()
    return m
  }

  private resetSessions(): void {
    for (const c of this.conversations.values()) c.sessionId = null
  }

  cancel(turnId: string): void {
    this.active.get(turnId)?.controller.abort()
  }

  /**
   * App quit: aborts every running turn and synchronously kills the CLI process trees
   * (claude/codex and their MCP servers; Windows does not kill children with the parent).
   */
  dispose(): void {
    this.disposed = true
    for (const t of this.active.values()) t.controller.abort()
    killAllChildren()
  }

  // ---- turns ----

  private promptContext(s: Settings): PromptContext {
    return { now: this.deps.now?.() ?? new Date(), categories: sortedCategories(s.categories), language: s.outputLanguage }
  }

  private conversationFor(req: ChatSendRequest, provider: ProviderId): ConversationState {
    if (req.conversationId) {
      const cached = this.conversations.get(req.conversationId)
      if (cached) return cached
      if (this.load(req.conversationId)) return this.conversations.get(req.conversationId)!
    }
    const c: ConversationState = {
      id: randomUUID().toUpperCase(),
      createdAt: nowSec(),
      provider,
      messages: [],
      history: [],
      sessionId: null,
      suggestionHistory: [],
    }
    this.conversations.set(c.id, c)
    return c
  }

  async send(req: ChatSendRequest): Promise<ChatTurnResult> {
    if (this.disposed) throw new Error('Chat is shutting down.')
    // One turn per conversation: the CLI session and the cached messages belong to that turn.
    if (req.conversationId && this.activeByConversation.has(req.conversationId)) throw new Error(TURN_IN_PROGRESS_ERROR)
    if (this.active.has(req.turnId)) throw new Error(`Turn ${req.turnId} is already running.`)
    const s = this.deps.getSettings()
    const provider = s.provider
    const conv = this.conversationFor(req, provider)
    // A CLI session only means something to the CLI that created it.
    if (conv.provider !== provider) conv.sessionId = null
    conv.provider = provider

    const text = req.text.trim()
    const controller = new AbortController()
    const snapshot: ActiveTurnSnapshot = {
      turnId: req.turnId,
      conversationId: conv.id,
      stage: 'thinking',
      visible: '',
      thinking: '',
      tools: [],
      error: null,
    }
    this.active.set(req.turnId, { controller, snapshot })
    this.activeByConversation.set(conv.id, req.turnId)
    try {
      const send = (ev: EventBody) => {
        trackSnapshot(snapshot, ev)
        this.deps.broadcast({ ...ev, turnId: req.turnId } as ChatEvent)
      }
      const debug = (kind: Extract<ChatEvent, { type: 'debug' }>['kind'], content: string) =>
        send({ type: 'debug', kind, content, at: Date.now() })

      conv.messages.push({ id: randomUUID().toUpperCase(), role: 'user', content: text, createdAt: nowSec() })
      conv.history.push({ role: 'user', content: text })
      debug('USER', text)

      // ---- turn state ----
      let raw = ''
      let sawDelta = false
      let pendingSeparator = false
      let stage: ChatStage = 'thinking'
      let streamError: string | null = null
      // While resuming a CLI session, errors are held back: a "session missing" error is followed
      // by a rebuild-from-history retry and must not reach the UI.
      let holdErrors = Boolean(conv.sessionId) && (provider === 'claude_cli' || provider === 'codex_cli')
      let heldErrors: string[] = []
      let lastFlushed = ''
      let flushTimer: ReturnType<typeof setTimeout> | null = null
      const tools: ToolRun[] = []
      /** Provider tool-call id -> ToolRun */
      const toolsById = new Map<string, ToolRun>()
      const setStage = (st: ChatStage) => {
        if (stage === st) return
        stage = st
        send({ type: 'stage', stage: st })
      }
      const flush = () => {
        flushTimer = null
        const visible = visibleStreamingText(raw)
        if (visible !== lastFlushed) {
          lastFlushed = visible
          send({ type: 'text', visible })
        }
      }
      const scheduleFlush = () => {
        if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS)
      }
      send({ type: 'stage', stage: 'thinking' })

      const emit: Emit = (ev: StreamEvent) => {
        switch (ev.type) {
          case 'session':
            if (!conv.sessionId) {
              conv.sessionId = ev.id
              debug('INFO', `Session ${ev.id}`)
            }
            break
          case 'thinking':
            if (stage !== 'error') setStage('thinking')
            send({ type: 'thinking', text: ev.text })
            break
          case 'toolStart': {
            setStage('runningTools')
            const t: ToolRun = { id: randomUUID(), command: ev.command, summary: toolSummary(ev.command, null, null), output: '', state: 'running' }
            tools.push(t)
            if (ev.id) toolsById.set(ev.id, t)
            debug('TOOL DETECTED', ev.command)
            send({ type: 'toolStart', tool: { ...t } })
            break
          }
          case 'toolEnd': {
            // Match by the provider's call id; without one, the oldest still-running call
            // (results of parallel calls arrive in call order).
            const t = (ev.id ? toolsById.get(ev.id) : undefined) ?? tools.find((x) => x.state === 'running')
            if (t) {
              t.output = ev.output
              t.summary = toolSummary(t.command, ev.output, ev.exitCode)
              t.state = ev.exitCode !== null && ev.exitCode !== 0 ? 'failed' : 'done'
              send({ type: 'toolEnd', tool: { ...t } })
            }
            pendingSeparator = true
            break
          }
          case 'textDelta': {
            if (!ev.text) break
            raw = pendingSeparator ? joinAfterTool(raw, ev.text) : raw + ev.text
            pendingSeparator = false
            sawDelta = true
            setStage('answering')
            scheduleFlush()
            break
          }
          case 'complete':
            if (!raw) raw = ev.text
            else if (pendingSeparator && ev.text && !sawDelta) raw = joinAfterTool(raw, ev.text)
            else if (!sawDelta) raw = ev.text
            pendingSeparator = false
            scheduleFlush()
            break
          case 'error':
            streamError = ev.message
            debug('ERROR', ev.message)
            if (holdErrors) heldErrors.push(ev.message)
            else {
              setStage('error')
              send({ type: 'error', message: ev.message })
            }
            break
          case 'debug':
            debug(ev.kind, ev.content)
            break
        }
      }

      let thrown: string | null = null
      let cancelled = false
      const releaseHeld = () => {
        holdErrors = false
        const held = heldErrors
        heldErrors = []
        for (const message of held) {
          setStage('error')
          send({ type: 'error', message })
        }
      }
      try {
        try {
          await this.runProvider(s, conv, emit, controller.signal, debug)
        } finally {
          holdErrors = false
        }
        // Resume failed because the CLI forgot the session: rebuild from history once.
        if (streamError && !raw.trim() && isMissingSessionError(streamError) && conv.sessionId) {
          debug('INFO', 'CLI session missing; rebuilding the conversation from history')
          heldErrors = []
          conv.sessionId = null
          streamError = null
          setStage('thinking')
          await this.runProvider(s, conv, emit, controller.signal, debug)
        } else releaseHeld()
      } catch (err) {
        if (err instanceof CancelledError || controller.signal.aborted) cancelled = true
        else thrown = err instanceof Error ? err.message : String(err)
        if (!cancelled) releaseHeld()
      } finally {
        if (flushTimer) {
          clearTimeout(flushTimer)
          flush()
        }
      }
      if (thrown) {
        debug('ERROR', thrown)
        send({ type: 'error', message: thrown })
      }
      debug('RESPONSE', raw)

      const parsed = parseMetadata(raw)
      let content = parsed.cleanedText
      const error = thrown ?? (!content && streamError ? streamError : null)
      if (error) content = content ? `${content}\n\nI encountered an error: ${error}` : `I encountered an error: ${error}`
      else if (cancelled && !content) content = ''
      if (content) {
        conv.messages.push({ id: randomUUID().toUpperCase(), role: 'assistant', content, createdAt: nowSec() })
        conv.history.push({ role: 'assistant', content: parsed.cleanedText || content })
      }

      let memory = this.storage.loadMemory()
      if (parsed.memory && !error && !cancelled) {
        const old = memory.text
        memory = this.storage.saveMemory(parsed.memory)
        if (memory.text !== old) {
          conv.sessionId = null
          debug('INFO', 'Reset CLI session: dashboard memory changed')
        }
      }
      if (parsed.suggestions.length) conv.suggestionHistory = updateSuggestionHistory(conv.suggestionHistory, parsed.suggestions)

      if (!conv.deleted) {
        this.storage.saveConversation({
          id: conv.id,
          title: conversationTitle(conv.messages.find((m) => m.role === 'user')?.content),
          provider,
          cliSessionId: provider === 'claude_cli' || provider === 'codex_cli' ? conv.sessionId : null,
          createdAt: conv.createdAt,
          messages: conv.messages,
        })
      }

      const result: ChatTurnResult = {
        turnId: req.turnId,
        conversationId: conv.id,
        messages: conv.messages.map((m) => ({ ...m })),
        suggestions: error || cancelled ? [] : parsed.suggestions,
        memory,
        error: error ?? (streamError && content ? streamError : null),
        cancelled,
      }
      // Lets a view that re-attached after a remount (and so isn't awaiting chat:send) finish the turn.
      this.deps.broadcast({ type: 'done', turnId: req.turnId, result })
      return result
    } finally {
      // Released only after the save, so load() never reads a half-finished conversation.
      this.active.delete(req.turnId)
      if (this.activeByConversation.get(conv.id) === req.turnId) this.activeByConversation.delete(conv.id)
    }
  }

  /** Runs one provider attempt. Protected so tests can substitute a scripted runner. */
  protected async runProvider(
    s: Settings,
    conv: ConversationState,
    emit: Emit,
    signal: AbortSignal,
    debug: (kind: 'PROMPT' | 'INFO', content: string) => void,
  ): Promise<void> {
    const ctx = this.promptContext(s)
    const memory = this.storage.loadMemory().text
    const runTool = (name: string, args: unknown) => executeTool(this.deps.db, name, args)
    if (s.provider === 'gemini' || s.provider === 'openai_compatible') {
      const system = buildSystemInstruction(geminiSystemPrompt(ctx), memory, conv.suggestionHistory.slice(-RECENT_SUGGESTIONS_SENT))
      debug('PROMPT', `${system}\n\n${conv.history.map((t) => `${t.role}: ${t.content}`).join('\n\n')}`)
      const input = { system, history: conv.history, executeTool: runTool, signal }
      if (s.provider === 'gemini') {
        await new GeminiChatRunner(this.deps.getSecret('geminiApiKey'), s.geminiModel).run(input, emit)
      } else {
        await new OpenAIChatRunner(s.openaiBaseUrl, s.openaiModel, this.deps.getSecret('openaiApiKey')).run(input, emit)
      }
      return
    }
    const cli = s.provider === 'claude_cli' ? 'claude' : 'codex'
    const latest = conv.history[conv.history.length - 1]?.content ?? ''
    const prompt = conv.sessionId ? latest : buildFlatPrompt(cliSystemPrompt(ctx, cli), memory, conv.history)
    debug('PROMPT', conv.sessionId ? `[resume ${conv.sessionId}]\n${prompt}` : prompt)
    const cfg: CliConfig = {
      command: cli === 'claude' ? s.claudeCommand || 'claude' : s.codexCommand || 'codex',
      model: s.cliModel.trim() || null,
      cwd: this.deps.cliCwd,
      mcp: this.deps.mcp,
    }
    const input = { prompt, sessionId: conv.sessionId, signal }
    if (cli === 'claude') await runClaude(cfg, input, emit)
    else await runCodex(cfg, input, emit)
  }
}

function cloneSnapshot(s: ActiveTurnSnapshot): ActiveTurnSnapshot {
  return { ...s, tools: s.tools.map((t) => ({ ...t })) }
}

/** Mirrors the renderer's event reducer so a remounted view can resume from the snapshot. */
function trackSnapshot(s: ActiveTurnSnapshot, ev: EventBody): void {
  switch (ev.type) {
    case 'stage':
      s.stage = ev.stage
      break
    case 'thinking':
      s.thinking += ev.text
      break
    case 'toolStart':
      s.stage = 'runningTools'
      s.tools.push({ ...ev.tool })
      break
    case 'toolEnd':
      s.tools = s.tools.map((t) => (t.id === ev.tool.id ? { ...ev.tool } : t))
      break
    case 'text':
      s.visible = ev.visible
      break
    case 'error':
      s.stage = 'error'
      s.error = ev.message
      break
  }
}

function sortedCategories(c: Category[]): Category[] {
  return [...c]
}

export function chatCliDir(dataDir: string): string {
  return join(dataDir, 'chatcli')
}
