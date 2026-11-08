// Daily Brief service (spec-daily.md §3b): triggers, the two parallel runs (docket + extras),
// cleaning, persistence, item actions, agent hand-offs and the range summary.
//
// Engines:
// - claude_cli: `claude -p` with WebSearch and the user's own connectors / MCP servers, which a
//   PreToolUse hook (a Node script run by the Electron binary with ELECTRON_RUN_AS_NODE=1) keeps
//   read-only. Bash/Edit/Write/WebFetch are not available at all (see runClaudePart).
// - any other provider: the same two runs from timeline data only, via generateText, with the
//   JSON schema enforced in code.

import { clipboard, dialog, nativeImage, Notification, shell, BrowserWindow, type MessageBoxOptions } from 'electron'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import type {
  BriefAction,
  BriefActionResult,
  BriefPart,
  BriefRunState,
  BriefSectionKey,
  BriefViewState,
  CompletedDayGroup,
  DailyBrief,
  DailyBriefContent,
  DailyBriefRangeSummary,
  DailyBriefRunStats,
  DocketItem,
  HandoffAgent,
  HandoffEntry,
  HandoffMethod,
  SummaryRange,
} from '../../shared/daily-types.ts'
import type { SettingsWithSecrets, TimelineCard } from '../../shared/types.ts'
import type { Store } from '../db.ts'
import { languageInstruction } from '../llm/prompts.ts'
import type { LLMProvider } from '../llm/types.ts'
import { logicalDay, shiftDay } from '../time.ts'
import {
  BRIEF_MIN_SOURCE_MINUTES,
  briefCards,
  buildPrompt,
  type Candidate,
  cardLines,
  categoriesWithDescriptions,
  chooseTemplate,
  claudeAbsRulePath,
  cleanDocket,
  cleanExtras,
  coerceToSchema,
  DOCKET_SCHEMA,
  emptyUserState,
  EXTRAS_SCHEMA,
  FEEDBACK_DAYS,
  feedbackSummary,
  hasAnySection,
  hookScriptSource,
  isSummaryRange,
  itemKey,
  keepFailedParts,
  kindsFor,
  lastHandoff,
  longDate,
  MAX_AUTOMATIC_BRIEF_ATTEMPTS,
  MAX_CANDIDATES,
  mcpWriteDenyRules,
  mergeParts,
  objectFromText,
  RANGE_LABELS,
  rangeStartDay,
  recentBriefItems,
  RUNNER_SOURCE,
  SHAPE_ERROR,
  slugify,
  SUMMARY_SCHEMA,
  type SummaryEntry,
  summaryEntryLines,
  terminalScript,
  unguardedToolCalls,
  validateSchema,
} from './brief-logic.ts'
import { CancelledError, generateTextAbortable, throwIfAborted } from './abortable.ts'
import { BriefFileStore } from './brief-store.ts'
import { claudeReadiness, runClaudeStructured } from './claude-runner.ts'
import { docketTemplate, extrasTemplate, overrideInstructionsBlock, rangeSummaryPrompt, type BriefToolMode } from './prompts.ts'
import { resolveCommand, which } from './spawn.ts'
import type { DailyStore } from './store.ts'

const RUN_TIMEOUT_MS = 20 * 60_000
const RUN_TIMEOUT_MESSAGE = 'Claude took longer than 20 minutes on your brief, so Dayflow stopped it. Try again.'
const SUMMARY_TIMEOUT_MS = 5 * 60_000
const HANDOFF_STALE_MS = 3 * 3600_000
// WebFetch is off in every brief run: with the user's connectors loaded, a prompt injection in an
// email or doc could otherwise carry data out in a URL. WebSearch result links are enough for the
// reading / news sections.
const DAYFLOW_DISALLOWED = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'WebFetch']
const HOOK_TIMEOUT_SECONDS = 60
const UNGUARDED_ERROR = "Dayflow couldn't confirm its read-only guard checked every connector call, so it discarded this part. Try again."
const RUN_CONFIRM_MAX_CHARS = 8000

export interface BriefDeps {
  store: Store
  daily: DailyStore
  files: BriefFileStore
  settings: () => SettingsWithSecrets
  makeProvider: () => LLMProvider
  broadcast: (channel: string, ...args: unknown[]) => void
  showWindow: () => void
}

interface PartOutput {
  value: Record<string, unknown> | null
  error: string | null
  stats: Partial<DailyBriefRunStats>
  promptCharacters: number
  usedOverride: boolean
}

function today(): string {
  return logicalDay(Math.floor(Date.now() / 1000))
}

function userFirstName(): string {
  try {
    const n = userInfo().username.trim()
    const first = n.split(/[\s._-]+/)[0]
    return first ? first.charAt(0).toUpperCase() + first.slice(1) : 'the user'
  } catch {
    return 'the user'
  }
}

function hhmm(ts: number): string {
  const d = new Date(ts * 1000)
  return `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`
}

export class BriefService {
  private readonly d: BriefDeps
  private run: BriefRunState = { kind: 'idle' }
  private lastFailedStats: DailyBriefRunStats | null = null
  private abort: AbortController | null = null
  private onScreenDay: string | null = null
  /** Background runs started in this session: output file → brief day. */
  private readonly runningHandoffs = new Map<string, string>()

  constructor(deps: BriefDeps) {
    this.d = deps
  }

  engine(): BriefToolMode {
    return this.d.settings().provider === 'claude_cli' ? 'connectors' : 'timeline'
  }

  private engineLabel(): string {
    const p = this.d.settings().provider
    if (p === 'claude_cli') return 'Claude Code with your connectors (read-only)'
    const name = p === 'gemini' ? 'Gemini' : p === 'codex_cli' ? 'ChatGPT (Codex CLI)' : 'your local model'
    return `${name}, from your timeline only`
  }

  state(): BriefViewState {
    const t = today()
    return {
      enabled: this.d.daily.settings().briefEnabled,
      today: t,
      brief: this.d.files.load(t) ?? this.latestBrief(),
      run: this.run,
      lastFailedRunStats: this.lastFailedStats,
      engine: this.engine(),
      engineLabel: this.engineLabel(),
    }
  }

  private latestBrief(): DailyBrief | null {
    return this.d.files.loadAll()[0] ?? null
  }

  private emit(): void {
    this.d.broadcast('daily:brief-state', this.state())
  }

  /** The renderer reports which brief day is on screen (null when hidden). */
  setOnScreen(day: string | null): void {
    this.onScreenDay = day
    if (day) {
      const b = this.d.files.load(day)
      if (b && !b.userState.hasBeenShown) {
        b.userState.hasBeenShown = true
        this.d.files.save(b)
      }
    }
  }

  // ---- triggers (3b.1) ----

  async runIfNeeded(trigger: 'launch' | 'app_active' | 'timer'): Promise<void> {
    if (!this.d.daily.settings().briefEnabled) return
    if (this.run.kind === 'running') return
    const t = today()
    if (this.d.files.load(t)) return
    const attempts = this.d.daily.getKV<Record<string, number>>('briefAutomaticAttempts', {})
    if ((attempts[t] ?? 0) >= MAX_AUTOMATIC_BRIEF_ATTEMPTS) return
    const source = this.sourceDayFor(t)
    if (this.d.daily.trackedMinutes(source) < BRIEF_MIN_SOURCE_MINUTES) return
    this.d.daily.setKV('briefAutomaticAttempts', { [t]: (attempts[t] ?? 0) + 1 })
    await this.start(t, source, trigger)
  }

  retry(): Promise<void> {
    if (this.run.kind === 'running') return Promise.resolve()
    const t = today()
    return this.start(t, this.sourceDayFor(t), 'retry')
  }

  cancel(): void {
    this.abort?.abort()
  }

  /** Previous logical day: (today's 4 AM start − 1 h).logicalDay. */
  private sourceDayFor(day: string): string {
    return shiftDay(day, -1)
  }

  private async start(day: string, sourceDay: string, trigger: string): Promise<void> {
    const started = Date.now()
    this.run = { kind: 'running', startedAt: new Date().toISOString(), trigger }
    this.abort = new AbortController()
    this.emit()
    try {
      const signal = this.abort.signal
      const { content, stats } = await this.generate(day, sourceDay, signal)
      throwIfAborted(signal)
      const existing = this.d.files.load(day)
      const merged = keepFailedParts(content, stats.failedParts ?? {}, existing)
      const userState = existing ? existing.userState : emptyUserState()
      if (this.onScreenDay === day) userState.hasBeenShown = true
      const brief: DailyBrief = {
        day,
        sourceDay,
        generatedAt: new Date().toISOString(),
        content: merged,
        userState,
        stats: { ...stats, durationSeconds: Math.round((Date.now() - started) / 1000), trigger },
      }
      this.d.files.save(brief)
      this.run = { kind: 'idle' }
      this.lastFailedStats = null
      if (trigger !== 'retry' && this.onScreenDay !== day) this.notifyReady(day)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.run = { kind: 'failed', message }
      const s = (err as { stats?: DailyBriefRunStats }).stats
      this.lastFailedStats = s ? { ...s, durationSeconds: Math.round((Date.now() - started) / 1000), trigger } : null
    } finally {
      this.abort = null
      this.emit()
    }
  }

  private notifyReady(day: string): void {
    this.d.broadcast('daily:brief-ready', day)
    if (!Notification.isSupported()) return
    const n = new Notification({ title: 'Your Daily Brief is ready', body: 'Open Dayflow to read it.' })
    n.on('click', () => {
      this.d.showWindow()
      this.d.broadcast('daily:open', day)
    })
    n.show()
  }

  // ---- generation (3b.2) ----

  private async generate(
    day: string,
    sourceDay: string,
    signal: AbortSignal,
  ): Promise<{ content: DailyBriefContent; stats: DailyBriefRunStats }> {
    const mode = this.engine()
    const settings = this.d.settings()
    const dailySettings = this.d.daily.settings()
    if (mode === 'connectors') {
      const notReady = await claudeReadiness(settings.claudeCommand || 'claude')
      if (notReady) throw new Error(notReady)
    }
    throwIfAborted(signal)

    const base = join(tmpdir(), 'dayflow-daily-brief', day)
    rmSync(base, { recursive: true, force: true })
    const candidatesDir = join(base, 'candidates')
    mkdirSync(candidatesDir, { recursive: true })
    const runDir = realpathSync.native(base)
    const candDir = realpathSync.native(candidatesDir)
    this.d.files.clearTranscripts(day)

    try {
      const cards = briefCards(this.d.store.cardsForDay(sourceDay), settings.categories)
      if (cards.length === 0) throw new Error("There's no activity from yesterday to build a brief from.")
      const candidates = this.writeCandidates(cards, candDir)
      throwIfAborted(signal)

      const t = today()
      const allBriefs = this.d.files.loadAll()
      const events = this.d.files.feedback()
      const now = new Date()
      const lang = languageInstruction(settings.outputLanguage, true)
      const common: Record<string, string> = {
        USER_NAME: userFirstName(),
        TODAY_LONG: longDate(day),
        YESTERDAY_LONG: longDate(sourceDay),
        TIMEZONE: Intl.DateTimeFormat().resolvedOptions().timeZone,
        CATEGORIES_WITH_DESCRIPTIONS: categoriesWithDescriptions(settings.categories),
        FEEDBACK_DAYS: String(FEEDBACK_DAYS),
        CANDIDATES_DIR: candDir,
        OVERRIDE_INSTRUCTIONS: overrideInstructionsBlock(dailySettings.briefOverrideInstructions),
      }
      const promptFor = (part: BriefPart) => {
        const { template, usedOverride } = chooseTemplate(
          part === 'docket' ? docketTemplate(mode) : extrasTemplate(mode),
          part === 'docket' ? dailySettings.briefPromptOverrideDocket : dailySettings.briefPromptOverrideExtras,
        )
        let prompt = buildPrompt(template, {
          ...common,
          YESTERDAY_CARDS: cardLines(cards, part === 'docket'),
          FEEDBACK_SUMMARY: feedbackSummary(events, kindsFor(part), now),
          RECENT_BRIEF_ITEMS: recentBriefItems(allBriefs, kindsFor(part), t),
        })
        if (lang) prompt += `\n\n## Language\n\n${lang}`
        return { prompt, usedOverride }
      }

      const runPart = (part: BriefPart): Promise<PartOutput> => {
        const { prompt, usedOverride } = promptFor(part)
        const schema = part === 'docket' ? DOCKET_SCHEMA : EXTRAS_SCHEMA
        const p =
          mode === 'connectors'
            ? this.runClaudePart(part, prompt, schema, runDir, candDir, signal)
            : this.runProviderPart(part, prompt, schema, signal)
        return p.then(
          (r) => {
            if (signal.aborted) throw new CancelledError()
            this.d.files.writeTranscript(day, part, r.transcript)
            return { value: r.value, error: r.error, stats: r.stats, promptCharacters: prompt.length, usedOverride }
          },
          (err) => ({
            value: null,
            error: err instanceof Error ? err.message : String(err),
            stats: {},
            promptCharacters: prompt.length,
            usedOverride,
          }),
        )
      }

      const [docket, extras] = await Promise.all([runPart('docket'), runPart('extras')])
      throwIfAborted(signal)

      const stats: DailyBriefRunStats = {
        durationSeconds: 0,
        model: docket.stats.model ?? extras.stats.model,
        costUSD: sum(docket.stats.costUSD, extras.stats.costUSD),
        inputTokens: sum(docket.stats.inputTokens, extras.stats.inputTokens),
        outputTokens: sum(docket.stats.outputTokens, extras.stats.outputTokens),
        cacheReadTokens: sum(docket.stats.cacheReadTokens, extras.stats.cacheReadTokens),
        numTurns: sum(docket.stats.numTurns, extras.stats.numTurns),
        promptCharacters: docket.promptCharacters + extras.promptCharacters,
        toolCalls: mergeCounts(docket.stats.toolCalls, extras.stats.toolCalls),
        cardCount: cards.length,
        candidateImageCount: candidates.length,
        usedPromptOverride: docket.usedOverride || extras.usedOverride,
        usedOverrideInstructions: dailySettings.briefOverrideInstructions.trim().length > 0,
        engine: mode === 'connectors' ? 'claude_cli_connectors' : `${settings.provider}_timeline`,
      }

      const docketIn = docket.error || !docket.value ? { error: docket.error ?? SHAPE_ERROR } : { items: cleanDocket(docket.value.items) }
      let extrasIn: DailyBriefContent | { error: string }
      let images: string[] = []
      if (extras.error || !extras.value) extrasIn = { error: extras.error ?? SHAPE_ERROR }
      else {
        const cleaned = cleanExtras(extras.value, candidates)
        extrasIn = cleaned.content
        images = cleaned.imagesToCopy
      }
      let merged: ReturnType<typeof mergeParts>
      try {
        merged = mergeParts(docketIn, extrasIn)
      } catch (err) {
        throw Object.assign(err as Error, { stats: { ...stats, failedParts: { docket: docket.error ?? '', extras: extras.error ?? '' } } })
      }
      stats.failedParts = Object.keys(merged.failedParts).length ? merged.failedParts : undefined
      throwIfAborted(signal)
      for (const f of images) {
        try {
          this.d.files.copyImage(day, join(candDir, f))
        } catch (err) {
          console.warn('[daily-brief] could not copy image', f, err)
        }
      }
      if (stats.failedParts && !hasAnySection(merged.content)) {
        const msg = Object.values(stats.failedParts).filter(Boolean).join(' ')
        throw Object.assign(new Error(msg || "Claude couldn't finish the brief. Try again."), { stats })
      }
      return { content: merged.content, stats }
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }

  /** Middle screenshot of each (evenly sampled) card, max 1280 px, JPEG quality 80. */
  private writeCandidates(cards: TimelineCard[], dir: string): Candidate[] {
    const n = cards.length
    const sampled = n <= MAX_CANDIDATES ? cards : Array.from({ length: MAX_CANDIDATES }, (_, i) => cards[Math.floor((i * n) / MAX_CANDIDATES)])
    const out: Candidate[] = []
    const index: { file: string; cardId: number; start: string; end: string; title: string }[] = []
    for (const c of sampled) {
      try {
        const shots = this.d.store.screenshotsInRange(c.startTs, c.endTs)
        if (shots.length === 0) continue
        const shot = shots[Math.floor(shots.length / 2)]
        if (!existsSync(shot.filePath)) continue
        let img = nativeImage.createFromPath(shot.filePath)
        if (img.isEmpty()) continue
        const { width, height } = img.getSize()
        const scale = Math.min(1, 1280 / Math.max(width, height))
        if (scale < 1) img = img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' })
        const file = `${c.id}_${hhmm(c.startTs)}.jpg`
        writeFileSync(join(dir, file), img.toJPEG(80))
        out.push({ file, cardId: c.id })
        index.push({ file, cardId: c.id, start: c.startTime, end: c.endTime, title: c.title })
      } catch (err) {
        console.warn('[daily-brief] candidate failed', c.id, err)
      }
    }
    writeFileSync(join(dir, 'index.json'), JSON.stringify(index, null, 2), 'utf8')
    return out
  }

  /**
   * One Claude run with the user's connectors loaded. Read-only is enforced in three layers:
   *
   * 1. Built-ins: `--tools` offers only WebSearch (+ Read for extras, limited by an allow rule to the
   *    candidates folder); Bash/Edit/Write/WebFetch are also disallowed outright.
   * 2. MCP tools: a PreToolUse hook (matcher `mcp__.*`) allows a call only when its name passes the
   *    read-verb allowlist in hookDecision. Backstop: `permissions.deny` globs for write verbs
   *    (mcpWriteDenyRules) in the same --settings file remove such tools from the session even if the
   *    hook never runs. (They live in the settings file rather than on the command line because ~500
   *    rules would overflow cmd.exe's 8 KB limit on the shell fallback; the effect is the same as
   *    --disallowedTools.)
   * 3. Heartbeat: the hook logs every decision. After the run, each MCP tool_use in the transcript
   *    must have a log line; if one doesn't, the hook didn't run for it (crash, timeout, managed
   *    `allowManagedHooksOnly`, ...) and Claude fell back to the user's own permission rules, so the
   *    part's output is discarded.
   *
   * Residual risk: the heartbeat check runs after the fact. An unguarded call that the user's own
   * permission rules allowed has already happened by then; only tools whose names slip past the
   * deny globs AND are allowed by the user's rules could be affected, and the result is never shown.
   * An allowlisted read tool can still send model-chosen parameters to that connector's own
   * service (e.g. a search query), and WebSearch queries go to the search provider; neither can
   * reach an arbitrary host. Settings under managed policy (`allowManagedPermissionRulesOnly`) can
   * drop layer 2; layer 3 still applies.
   */
  private async runClaudePart(
    part: BriefPart,
    prompt: string,
    schema: object,
    runDir: string,
    candDir: string,
    signal: AbortSignal,
  ) {
    const s = this.d.settings()
    const hookFile = join(runDir, `${part}_read_only_hook.js`)
    const hookLog = join(runDir, `${part}_hook.log`)
    writeFileSync(hookFile, hookScriptSource(hookLog), 'utf8')
    const fwd = (p: string) => p.replace(/\\/g, '/')
    // Forward slashes and double quotes work whether Claude Code runs hooks through cmd or Git Bash.
    const hookCommand = `"${fwd(process.execPath)}" "${fwd(hookFile)}"`
    const settings: Record<string, unknown> = {
      // --settings outranks user/project settings, so a user-level "disableAllHooks" can't switch the guard off.
      disableAllHooks: false,
      hooks: {
        PreToolUse: [{ matcher: 'mcp__.*', hooks: [{ type: 'command', command: hookCommand, timeout: HOOK_TIMEOUT_SECONDS }] }],
      },
      permissions: { deny: [...DAYFLOW_DISALLOWED, ...mcpWriteDenyRules()] },
    }
    if (part === 'docket') settings.effortLevel = 'medium'
    const settingsFile = join(runDir, `${part}_settings.json`)
    writeFileSync(settingsFile, JSON.stringify(settings), 'utf8')
    const allowed = ['WebSearch']
    if (part === 'extras') allowed.push(`Read(${claudeAbsRulePath(candDir)}/**)`)
    const res = await runClaudeStructured({
      command: s.claudeCommand || 'claude',
      prompt,
      schema,
      name: `dayflow-daily-brief-${part}`,
      tools: part === 'docket' ? 'WebSearch' : 'Read,WebSearch',
      allowedTools: allowed,
      disallowedTools: DAYFLOW_DISALLOWED,
      settings: settingsFile,
      // No --strict-mcp-config: the user's own connectors / MCP servers load (guarded by the hook).
      strictMcp: false,
      model: this.d.daily.settings().briefModel || 'opus',
      cwd: runDir,
      timeoutMs: RUN_TIMEOUT_MS,
      timeoutMessage: RUN_TIMEOUT_MESSAGE,
      // The hook runs the Electron binary as plain Node. MCP servers spawned by Claude inherit this
      // variable too; that only matters for Electron-based MCP servers, which are rare.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      signal,
    })
    let log = ''
    try {
      log = readFileSync(hookLog, 'utf8')
    } catch {
      /* no MCP calls (or the hook never ran: checked below) */
    }
    let transcript = res.transcript
    if (log) transcript += `\n\n---\n\n# Read-only guard decisions\n\n${log}`
    const unguarded = unguardedToolCalls(res.stats.toolCalls, log)
    if (unguarded.length) {
      console.warn(`[daily-brief] ${part}: MCP calls without a hook decision`, unguarded)
      transcript += `\n\n---\n\n# Discarded\n\nThe read-only guard has no record of: ${unguarded.join(', ')}`
      return { value: null, error: UNGUARDED_ERROR, stats: res.stats, transcript }
    }
    if (res.value) {
      const problems = validateSchema(res.value, schema as Record<string, unknown>)
      if (problems.length) console.warn(`[daily-brief] ${part} schema issues`, problems.slice(0, 5))
    }
    return { ...res, transcript }
  }

  /** Timeline-only run through the configured provider; schema enforced here. */
  private async runProviderPart(part: BriefPart, prompt: string, schema: object, signal: AbortSignal) {
    let provider: LLMProvider
    try {
      provider = this.d.makeProvider()
    } catch (err) {
      return { value: null, error: err instanceof Error ? err.message : String(err), stats: {}, transcript: `# Prompt\n\n${prompt}` }
    }
    const full = `${prompt}\n\nReturn ONLY one JSON object that matches this JSON Schema, with no markdown fences and nothing before or after it:\n${JSON.stringify(schema)}`
    let raw = ''
    try {
      raw = await generateTextAbortable(provider, full, `daily_brief_${part}`, true, signal)
    } catch (err) {
      if (signal.aborted) throw new CancelledError()
      const msg = err instanceof Error ? err.message : String(err)
      return {
        value: null,
        error: `${this.engineLabel().split(',')[0]} couldn't write the brief: ${msg.slice(0, 200)}`,
        stats: { model: provider.model ?? undefined },
        transcript: `# Prompt\n\n${full}\n\n---\n\n# Error\n\n${msg}`,
      }
    }
    const obj = objectFromText(raw)
    const coerced = obj ? (coerceToSchema(obj, schema as Record<string, unknown>) as Record<string, unknown> | undefined) : undefined
    const transcript = `# Prompt\n\n${full}\n\n---\n\n# Result\n\n${raw}`
    if (!coerced) {
      return { value: null, error: "The model's answer came back in an unexpected shape. Try again.", stats: { model: provider.model ?? undefined }, transcript }
    }
    return { value: coerced, error: null, stats: { model: provider.model ?? undefined }, transcript }
  }

  // ---- item actions (3b.8) ----

  async action(day: string, a: BriefAction): Promise<BriefActionResult> {
    // A background run executes a model-written prompt (derived from emails, docs, ...) without
    // anyone watching, so the user must see and confirm the exact prompt first. Asked before the
    // brief is loaded, so edits made while the dialog is open aren't overwritten.
    let confirmedPrompt: string | undefined
    if (a.type === 'handoff' && a.method === 'run') {
      const pre = this.d.files.load(day)
      const item = pre?.content.docket?.find((d) => d.title === a.title)
      if (!pre || !item) return { brief: pre, message: 'That task no longer exists.' }
      confirmedPrompt = this.handoffPrompt(pre, item)
      if (!(await this.confirmRun(confirmedPrompt, a.agent))) return { brief: pre, message: 'Background run cancelled.' }
    }
    const brief = this.d.files.load(day)
    if (!brief) return { brief: null, message: 'That brief no longer exists.' }
    const st = brief.userState
    const fb = (section: string, itemTitle: string, action: 'opened' | 'saved' | 'dismissed' | 'checked' | 'expanded') =>
      this.d.files.addFeedback({ day, section, itemTitle, action, at: new Date().toISOString() })
    let message: string | undefined
    switch (a.type) {
      case 'toggleCheck': {
        const k = itemKey(a.section, a.title)
        if (st.checkedItemKeys.includes(k)) st.checkedItemKeys = st.checkedItemKeys.filter((x) => x !== k)
        else {
          st.checkedItemKeys.push(k)
          fb(a.section, a.title, 'checked')
        }
        break
      }
      case 'dismissItem': {
        const k = itemKey(a.section, a.title)
        if (!st.dismissedItemKeys.includes(k)) st.dismissedItemKeys.push(k)
        fb(a.section, a.title, 'dismissed')
        break
      }
      case 'addTask':
        if (a.title.trim()) st.addedTasks.push({ id: randomUUID(), title: a.title.trim() })
        break
      case 'removeTask':
        st.addedTasks = st.addedTasks.filter((t) => t.id !== a.id)
        break
      case 'setPromptEdit': {
        const original = brief.content.docket?.find((d) => d.title === a.title)?.prompt ?? ''
        if (a.prompt === original || !a.prompt.trim()) delete st.promptEdits[a.title]
        else st.promptEdits[a.title] = a.prompt
        break
      }
      case 'setFolder':
        st.folders[a.title] = a.folder
        if (a.folder) this.rememberFolder(a.folder)
        break
      case 'handoff': {
        const item = brief.content.docket?.find((d) => d.title === a.title)
        if (!item) break
        const prompt = this.handoffPrompt(brief, item)
        if (a.method === 'run' && prompt !== confirmedPrompt) {
          message = 'The prompt changed after you confirmed it. Click Run again.'
          break
        }
        const entry: HandoffEntry = {
          title: a.title,
          dismissed: false,
          agent: a.agent,
          method: a.method,
          at: new Date().toISOString(),
          reviewed: false,
          failed: false,
        }
        try {
          message = this.handoff(day, item, prompt, a.agent, a.method, st.folders[a.title] ?? '', entry)
        } catch (err) {
          entry.failed = true
          message = err instanceof Error ? err.message : String(err)
        }
        st.handoffs.push(entry)
        fb('docket', a.title, 'opened')
        break
      }
      case 'dismissDocket':
        st.handoffs.push({ title: a.title, dismissed: true, at: new Date().toISOString(), reviewed: false, failed: false })
        fb('docket', a.title, 'dismissed')
        break
      case 'undoDismissDocket': {
        const last = lastHandoff(st, a.title)
        if (last?.dismissed) st.handoffs.splice(st.handoffs.lastIndexOf(last), 1)
        break
      }
      case 'setDismissReason': {
        const last = lastHandoff(st, a.title)
        if (last?.dismissed) last.reason = a.reason
        break
      }
      case 'openResult': {
        const last = lastHandoff(st, a.title)
        if (last) {
          if (last.outputFile && existsSync(last.outputFile)) void shell.openPath(last.outputFile)
          last.reviewed = true
        }
        break
      }
      case 'resetDocket':
        st.handoffs = []
        st.promptEdits = {}
        st.folders = {}
        break
      case 'saveImage': {
        const saved = this.d.files.saveImage(day, a.file, a.caption)
        if (saved) {
          fb('site_seeing', a.caption ?? a.file, 'saved')
          message = 'Saved to your gallery.'
        }
        break
      }
      case 'feedback':
        fb(a.section, a.title, a.action)
        return { brief }
    }
    this.d.files.save(brief)
    return { brief, message }
  }

  private rememberFolder(folder: string): void {
    const s = this.d.daily.settings()
    const next = [folder, ...s.docketPickedFolders.filter((f) => f.toLowerCase() !== folder.toLowerCase())].slice(0, 5)
    this.d.daily.updateSettings({ docketPickedFolders: next })
  }

  async pickFolder(): Promise<string | null> {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const opts = { title: 'Choose a folder for the agent', properties: ['openDirectory' as const] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths[0]) return null
    this.rememberFolder(r.filePaths[0])
    return r.filePaths[0]
  }

  /** Picked folders first, then Claude Code projects by recent use; existing folders only, max 5. */
  recentFolders(): string[] {
    const out: string[] = []
    const add = (p: string) => {
      if (out.length >= 5 || out.some((x) => x.toLowerCase() === p.toLowerCase())) return
      try {
        if (statSync(p).isDirectory()) out.push(p)
      } catch {
        /* gone */
      }
    }
    this.d.daily.settings().docketPickedFolders.forEach(add)
    try {
      const cfg = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')) as { projects?: Record<string, unknown> }
      const projects = Object.keys(cfg.projects ?? {})
      const mtime = (p: string) => {
        try {
          return statSync(join(homedir(), '.claude', 'projects', p.replace(/[^a-zA-Z0-9]/g, '-'))).mtimeMs
        } catch {
          return 0
        }
      }
      projects
        .map((p) => ({ p: p.replace(/\//g, '\\'), t: mtime(p) }))
        .sort((a, b) => b.t - a.t)
        .forEach((x) => add(x.p))
    } catch {
      /* no Claude config */
    }
    return out
  }

  private handoffPrompt(brief: DailyBrief, item: DocketItem): string {
    return (brief.userState.promptEdits[item.title] ?? item.prompt ?? item.title).trim()
  }

  /** Shows the full prompt of a background run and asks for confirmation (main process, so the renderer can't skip it). */
  private async confirmRun(prompt: string, agent: HandoffAgent): Promise<boolean> {
    const name = agent === 'claude' ? 'Claude Code' : 'Codex'
    const shown =
      prompt.length > RUN_CONFIRM_MAX_CHARS
        ? `${prompt.slice(0, RUN_CONFIRM_MAX_CHARS)}\n\n… (${prompt.length - RUN_CONFIRM_MAX_CHARS} more characters)`
        : prompt
    const opts: MessageBoxOptions = {
      type: 'warning',
      title: 'Run this task in the background?',
      message: `${name} will run this prompt in the background, in read-only mode. The brief wrote it from your emails, docs and activity, so read it before you run it.`,
      detail: shown,
      buttons: ['Run', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    }
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
    return r.response === 0
  }

  /** Hands a docket task to an agent. Returns a short message for the UI. */
  private handoff(
    day: string,
    item: DocketItem,
    prompt: string,
    agent: HandoffAgent,
    method: HandoffMethod,
    folder: string,
    entry: HandoffEntry,
  ): string {
    clipboard.writeText(prompt)
    if (method === 'copy') return 'Prompt copied to the clipboard.'
    const s = this.d.settings()
    const command = agent === 'claude' ? s.claudeCommand || 'claude' : s.codexCommand || 'codex'
    const dir = this.d.files.handoffsDir(day)
    const base = join(dir, `${slugify(item.title)}-${Math.floor(Date.now() / 1000)}`)
    const promptFile = `${base}.prompt`
    writeFileSync(promptFile, prompt, 'utf8')
    const cwd = folder && existsSync(folder) ? folder : dir

    if (method === 'terminal') {
      // The prompt travels as a file: long multi-line text can't be passed safely on a command line.
      // The command line itself goes into a .cmd file too, so paths with spaces or parentheses
      // survive wt / start / cmd quoting (`cmd /k call "<file>"` never has its quotes stripped).
      const ask = `Read the task in ${promptFile} and do it. Ask me before sending, posting or deleting anything.`
      const cmdFile = `${base}.cmd`
      writeFileSync(cmdFile, terminalScript(cwd, which(command) ?? command, ask), 'utf8')
      const resolved = resolveCommand('wt')
      const launched = resolved && !resolved.viaShell
        ? spawn(resolved.file, ['-w', 'new', '-d', cwd, '--title', 'Dayflow task', 'cmd', '/k', 'call', cmdFile], {
            detached: true,
            stdio: 'ignore',
            windowsHide: false,
          })
        : spawn('cmd.exe', ['/c', 'start', '"Dayflow task"', '/D', `"${cwd}"`, 'cmd', '/k', 'call', `"${cmdFile}"`], {
            detached: true,
            stdio: 'ignore',
            windowsVerbatimArguments: true,
            windowsHide: false,
          })
      launched.on('error', (err) => console.warn('[daily-brief] terminal hand-off failed', err))
      launched.unref()
      return `Opened ${agent === 'claude' ? 'Claude Code' : 'Codex'} in a new terminal. The prompt is also on your clipboard.`
    }

    // method === 'run': background run in a safe mode; output and exit code are written next to the
    // prompt. Claude: default permission mode (in -p nobody can approve, so edits and commands the
    // user's own allow rules don't cover are refused). Codex: read-only sandbox, no network.
    const resolved = resolveCommand(command)
    if (!resolved) throw new Error(`${command} is not installed or not on PATH.`)
    const out = `${base}.txt`
    const args = agent === 'claude' ? ['-p', '--permission-mode', 'default'] : ['exec', '-s', 'read-only', '--skip-git-repo-check', '-']
    // A small detached Node runner (the Electron binary as Node) owns the agent process and writes
    // `<out>.exit` when it ends, so the run survives quitting Dayflow and always leaves its marker.
    const runner = join(dir, 'dayflow-run.js')
    writeFileSync(runner, RUNNER_SOURCE, 'utf8')
    const cfgFile = `${base}.run.json`
    writeFileSync(
      cfgFile,
      JSON.stringify({
        cwd,
        promptFile,
        outFile: out,
        exitFile: `${out}.exit`,
        viaShell: resolved.viaShell,
        file: resolved.file,
        args: [...resolved.prefixArgs, ...args],
        shellCommand: `"${resolved.file}" ${args.join(' ')}`,
      }),
      'utf8',
    )
    const child = spawn(process.execPath, [runner, cfgFile], {
      cwd: dir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    child.on('error', () => {
      try {
        writeFileSync(`${out}.exit`, '-1', 'utf8')
      } catch {
        /* ignore */
      }
    })
    child.unref()
    entry.outputFile = out
    this.runningHandoffs.set(out, day)
    this.watchRuns()
    return `${agent === 'claude' ? 'Claude Code' : 'Codex'} is working on it in the background (read-only).`
  }

  private runWatch: ReturnType<typeof setInterval> | null = null

  /** Polls for the `.exit` markers of runs started in this session and pushes the update. */
  private watchRuns(): void {
    if (this.runWatch) return
    this.runWatch = setInterval(() => {
      const days = new Set<string>()
      for (const [out, day] of [...this.runningHandoffs]) {
        if (existsSync(`${out}.exit`)) {
          this.runningHandoffs.delete(out)
          days.add(day)
        }
      }
      for (const day of days) this.refreshRuns(day)
      if (days.size) this.emit()
      if (this.runningHandoffs.size === 0 && this.runWatch) {
        clearInterval(this.runWatch)
        this.runWatch = null
      }
    }, 5000)
  }

  /** Reads `.exit` files left by background runs; runs with no `.exit` after 3 h are marked failed. */
  refreshRuns(day: string): DailyBrief | null {
    const brief = this.d.files.load(day)
    if (!brief) return null
    let changed = false
    for (const h of brief.userState.handoffs) {
      if (h.method !== 'run' || h.finishedAt || h.failed || !h.outputFile) continue
      const exitFile = `${h.outputFile}.exit`
      if (existsSync(exitFile)) {
        const code = Number(readFileSync(exitFile, 'utf8').trim())
        h.finishedAt = statSync(exitFile).mtime.toISOString()
        h.failed = code !== 0
        changed = true
      } else if (!this.runningHandoffs.has(h.outputFile) && Date.now() - Date.parse(h.at) > HANDOFF_STALE_MS) {
        h.failed = true
        changed = true
      }
    }
    if (changed) this.d.files.save(brief)
    return brief
  }

  // ---- completed history and range summary (3b.9) ----

  completedHistory(): CompletedDayGroup[] {
    return this.d.files
      .loadAll()
      .filter((b) => b.content.completed_yesterday?.length)
      .map((b) => ({ day: b.day, sourceDay: b.sourceDay, items: b.content.completed_yesterday! }))
  }

  async summarize(range: SummaryRange): Promise<DailyBriefRangeSummary> {
    if (!isSummaryRange(range)) throw new Error('Invalid range')
    const startDay = rangeStartDay(range, new Date())
    const endDay = today()
    const entries: SummaryEntry[] = []
    for (const b of this.d.files.loadAll()) {
      if (!b.sourceDay || b.sourceDay < startDay) continue
      for (const c of b.content.completed_yesterday ?? []) {
        entries.push({ day: b.sourceDay, project: c.project, title: c.title, apps: c.apps, imageFile: c.imageFile, briefDay: b.day })
      }
    }
    if (entries.length === 0) throw new Error('No completed work saved in this range yet.')
    entries.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    let prompt = rangeSummaryPrompt(startDay, endDay, RANGE_LABELS[range].toLowerCase(), summaryEntryLines(entries))
    const lang = languageInstruction(this.d.settings().outputLanguage, true)
    if (lang) prompt += `\n\n${lang}`

    let value: Record<string, unknown> | null = null
    if (this.engine() === 'connectors') {
      const dir = join(tmpdir(), 'dayflow-daily-brief')
      mkdirSync(dir, { recursive: true })
      const res = await runClaudeStructured({
        command: this.d.settings().claudeCommand || 'claude',
        prompt,
        schema: SUMMARY_SCHEMA,
        name: 'dayflow-daily-brief-summary',
        tools: '',
        allowedTools: [],
        strictMcp: true,
        model: this.d.daily.settings().briefModel || 'opus',
        cwd: dir,
        timeoutMs: SUMMARY_TIMEOUT_MS,
        timeoutMessage: 'Claude took longer than 5 minutes on the summary, so Dayflow stopped it. Try again.',
      })
      if (res.error) throw new Error(res.error)
      value = res.value
    } else {
      const provider = this.d.makeProvider()
      const raw = await provider.generateText(
        `${prompt}\n\nReturn ONLY one JSON object matching this JSON Schema:\n${JSON.stringify(SUMMARY_SCHEMA)}`,
        'daily_brief_summary',
        true,
      )
      const obj = objectFromText(raw)
      value = obj ? ((coerceToSchema(obj, SUMMARY_SCHEMA) as Record<string, unknown> | undefined) ?? null) : null
    }
    if (!value) throw new Error(SHAPE_ERROR)
    const projects = (Array.isArray(value.projects) ? value.projects : []) as Record<string, unknown>[]
    const summary: DailyBriefRangeSummary = {
      range,
      startDay,
      endDay,
      generatedAt: new Date().toISOString(),
      overview: String(value.overview ?? '').trim(),
      milestones: (Array.isArray(value.milestones) ? value.milestones : []).map((m) => String(m).trim()).filter(Boolean),
      projects: projects
        .map((p) => {
          const title = String(p.title ?? '').trim()
          const bullets = (Array.isArray(p.bullets) ? p.bullets : []).map((b) => String(b).trim()).filter(Boolean)
          const idx = typeof p.imageEntryIndex === 'number' ? p.imageEntryIndex : -1
          const e = entries[idx]
          const impact = typeof p.impact === 'string' && p.impact.trim() ? p.impact.trim() : undefined
          return { title, bullets, impact, imageFile: e?.imageFile ? `${e.briefDay}/${e.imageFile}` : undefined }
        })
        .filter((p) => p.title && p.bullets.length),
    }
    this.d.files.saveSummary(summary)
    return summary
  }

  defaultPrompt(part: BriefPart): string {
    return part === 'docket' ? docketTemplate(this.engine()) : extrasTemplate(this.engine())
  }

  isSection(k: string): k is BriefSectionKey {
    return ['docket', 'keep_tracking', 'completed_yesterday', 'team_decisions', 'related_reading', 'industry_news', 'site_seeing'].includes(k)
  }
}

function sum(a?: number, b?: number): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)
}

function mergeCounts(a?: Record<string, number>, b?: Record<string, number>): Record<string, number> | undefined {
  if (!a && !b) return undefined
  const out: Record<string, number> = { ...(a ?? {}) }
  for (const [k, v] of Object.entries(b ?? {})) out[k] = (out[k] ?? 0) + v
  return out
}
