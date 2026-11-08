// Chat with your work journal (DashboardChat in the macOS app). The provider is the one chosen
// in Settings; the main process streams `chat:event` updates while a turn runs.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  ChatEvent,
  ChatMemory,
  ChatMessage,
  ChatStatus,
  ChatTurnResult,
  ConversationDetail,
  ConversationSummary,
} from '../../../shared/chat-types.ts'
import type { SettingsWithSecrets } from '../../../shared/types.ts'
import { AssistantBubble, Suggestions, UserBubble, type WorkStatus, WorkStatusCard } from './chat/Message.tsx'
import { type DebugEntry, DebugPanel, HistoryPanel, MemoryPanel, PROVIDER_LABEL } from './chat/Panels.tsx'
import { Icon } from './chat/icons.tsx'
import './chat.css'

const PROMPTS = [
  'Generate standup notes for yesterday',
  'What did I get done last week?',
  'When was I most focused this week',
  'Compare this week to last week',
]

const ANCHOR_GAP = 64
const EDGE_THRESHOLD = 8
const MAX_DEBUG = 400

const call = <T,>(channel: string, ...args: unknown[]) => window.dayflow.call<T>(channel, ...args)

function newId(): string {
  return crypto.randomUUID()
}

export function ChatView({ settings }: { settings: SettingsWithSecrets }) {
  const [status, setStatus] = useState<ChatStatus | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streamText, setStreamText] = useState('')
  const [work, setWork] = useState<WorkStatus | null>(null)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [turnId, setTurnId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const [showMemory, setShowMemory] = useState(false)
  const [showDebug, setShowDebug] = useState(false)
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [memory, setMemory] = useState<ChatMemory>({ text: '', updatedAt: null })
  const [memoryDraft, setMemoryDraft] = useState('')
  const [debug, setDebug] = useState<DebugEntry[]>([])
  const [atEdge, setAtEdge] = useState(true)
  const [spacer, setSpacer] = useState(0)

  const turnRef = useRef<string | null>(null)
  /** Results of turns that finished while this view wasn't attached to them (see re-attach). */
  const doneRef = useRef(new Map<string, ChatTurnResult>())
  const finishRef = useRef<(r: ChatTurnResult) => void>(() => {})
  const scrollRef = useRef<HTMLDivElement>(null)
  const lastTurnRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const anchorNext = useRef<'user' | 'restore' | null>(null)
  const memoryDirty = memoryDraft.trim() !== memory.text

  const processing = turnId !== null

  // ---- data ----

  const refreshStatus = useCallback(() => {
    void call<ChatStatus>('chat:status').then(setStatus)
  }, [])

  useEffect(() => {
    refreshStatus()
    const t = setInterval(refreshStatus, 30_000)
    return () => clearInterval(t)
  }, [refreshStatus, settings.provider, settings.hasGeminiKey, settings.claudeCommand, settings.codexCommand, settings.openaiModel])

  const refreshConversations = useCallback(() => {
    void call<ConversationSummary[]>('chat:list').then(setConversations)
  }, [])

  useEffect(() => {
    void call<ChatMemory>('chat:getMemory').then((m) => {
      setMemory(m)
      setMemoryDraft(m.text)
    })
  }, [])

  useEffect(() => {
    if (showHistory) refreshConversations()
  }, [showHistory, refreshConversations])

  useEffect(
    () =>
      window.dayflow.on('chat:event', (...args: unknown[]) => {
        const ev = args[0] as ChatEvent
        if (ev.type === 'debug') {
          setDebug((d) => [...d.slice(-MAX_DEBUG + 1), { at: ev.at, kind: ev.kind, content: ev.content }])
          return
        }
        if (ev.type === 'done') {
          if (ev.turnId === turnRef.current) finishRef.current(ev.result)
          else {
            const done = doneRef.current
            done.set(ev.turnId, ev.result)
            if (done.size > 20) done.delete(done.keys().next().value as string)
          }
          return
        }
        if (ev.turnId !== turnRef.current) return
        switch (ev.type) {
          case 'stage':
            setWork((w) => (w ? { ...w, stage: ev.stage } : w))
            break
          case 'thinking':
            setWork((w) => (w ? { ...w, thinking: w.thinking + ev.text } : w))
            break
          case 'toolStart':
            setWork((w) => (w ? { ...w, stage: 'runningTools', tools: [...w.tools, ev.tool] } : w))
            break
          case 'toolEnd':
            setWork((w) => (w ? { ...w, tools: w.tools.map((t) => (t.id === ev.tool.id ? ev.tool : t)) } : w))
            break
          case 'text':
            setStreamText(ev.visible)
            break
          case 'error':
            setWork((w) => (w ? { ...w, stage: 'error', error: ev.message } : w))
            break
        }
      }),
    [],
  )

  // ---- scrolling ----

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    setAtEdge(el.scrollHeight - el.scrollTop - el.clientHeight <= EDGE_THRESHOLD)
  }

  const scrollToBottom = () => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  useLayoutEffect(() => {
    const el = scrollRef.current
    const turn = lastTurnRef.current
    if (!el) return
    // Reserve room under the latest user message so it can sit near the top while the reply streams.
    const turnH = turn ? turn.offsetHeight : 0
    // Only recomputed while a turn runs (or right after anchoring), so finishing a turn doesn't jump.
    const want = Math.max(0, el.clientHeight - ANCHOR_GAP - turnH)
    if ((processing || anchorNext.current) && want !== spacer) setSpacer(want)
    if (anchorNext.current && turn) {
      el.scrollTop = Math.max(0, turn.offsetTop - ANCHOR_GAP)
      anchorNext.current = null
      setAtEdge(true)
      return
    }
    if (processing && atEdge && spacer === 0) scrollToBottom()
  })

  // ---- actions ----

  const resetView = () => {
    setConversationId(null)
    setMessages([])
    setStreamText('')
    setWork(null)
    setSuggestions([])
    setSpacer(0)
  }

  const applyMemory = (m: ChatMemory) => {
    setMemory(m)
    if (!memoryDirty) setMemoryDraft(m.text)
  }

  /** Ends the current turn with its result; a no-op for any other (or an already finished) turn. */
  const finishTurn = (result: ChatTurnResult) => {
    if (turnRef.current !== result.turnId) return
    turnRef.current = null
    setTurnId(null)
    setStreamText('')
    setConversationId(result.conversationId)
    setMessages(result.messages)
    setSuggestions(result.suggestions)
    applyMemory(result.memory)
    const last = result.messages[result.messages.length - 1]
    const answered = last?.role === 'assistant' && !result.error
    if (result.cancelled || answered) setWork(null)
    else if (result.error) setWork((w) => ({ ...(w ?? { tools: [], thinking: '' }), stage: 'error', error: result.error }))
    if (showHistory) refreshConversations()
  }
  finishRef.current = finishTurn

  // A turn keeps running in the main process when this view unmounts (tab switch); on mount,
  // re-attach to it so its progress and result still show up.
  useEffect(() => {
    let alive = true
    void (async () => {
      const st = await call<ChatStatus>('chat:status')
      const active = st.activeTurn
      if (!alive || !active || turnRef.current) return
      const c = await call<ConversationDetail | null>('chat:load', active.conversationId)
      if (!alive || !c || turnRef.current) return
      setConversationId(c.id)
      setMessages(c.messages)
      setSuggestions([])
      anchorNext.current = 'restore'
      const live = c.activeTurn
      if (!live) {
        setWork(null)
        return
      }
      turnRef.current = live.turnId
      setTurnId(live.turnId)
      setStreamText(live.visible)
      setWork({ stage: live.stage, tools: live.tools, thinking: live.thinking, error: live.error })
      // It may have finished between chat:load and now.
      const done = doneRef.current.get(live.turnId)
      if (done) finishTurn(done)
    })()
    return () => {
      alive = false
    }
    // Mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const send = async (raw: string) => {
    const text = raw.trim()
    if (!text || processing || !status?.available) return
    const tid = newId()
    turnRef.current = tid
    setTurnId(tid)
    setInput('')
    setSuggestions([])
    setStreamText('')
    setWork({ stage: 'thinking', tools: [], thinking: '', error: null })
    setMessages((m) => [...m, { id: `pending-${tid}`, role: 'user', content: text, createdAt: Math.floor(Date.now() / 1000) }])
    anchorNext.current = 'user'
    let result: ChatTurnResult
    try {
      result = await call<ChatTurnResult>('chat:send', { turnId: tid, conversationId, text })
    } catch (err) {
      if (turnRef.current === tid) {
        turnRef.current = null
        setTurnId(null)
        setStreamText('')
      }
      setWork((w) => ({ ...(w ?? { tools: [], thinking: '' }), stage: 'error', error: err instanceof Error ? err.message : String(err) }))
      return
    }
    // Usually already finished by the 'done' event; then this is a no-op.
    finishTurn(result)
  }

  const cancel = () => {
    if (turnRef.current) void call('chat:cancel', turnRef.current)
  }

  const openConversation = async (id: string) => {
    if (processing || id === conversationId) return
    const c = await call<ConversationDetail | null>('chat:load', id)
    if (!c) {
      refreshConversations()
      return
    }
    setConversationId(c.id)
    setMessages(c.messages)
    setSuggestions([])
    setWork(null)
    setStreamText('')
    anchorNext.current = 'restore'
    const live = c.activeTurn
    if (live && !turnRef.current) {
      turnRef.current = live.turnId
      setTurnId(live.turnId)
      setStreamText(live.visible)
      setWork({ stage: live.stage, tools: live.tools, thinking: live.thinking, error: live.error })
      const done = doneRef.current.get(live.turnId)
      if (done) finishTurn(done)
    }
  }

  const deleteConversation = async (id: string) => {
    await call('chat:delete', id)
    if (id === conversationId) resetView()
    refreshConversations()
  }

  const pickSuggestion = (s: string) => {
    setInput(s)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(s.length, s.length)
    })
  }

  // ---- render ----

  if (!status) return <div className="chat" />

  if (!status.betaAccepted) return <BetaGate status={status} onAccept={() => void call<ChatStatus>('chat:acceptBeta').then(setStatus)} />

  const lastUserIdx = messages.map((m) => m.role).lastIndexOf('user')
  const before = lastUserIdx >= 0 ? messages.slice(0, lastUserIdx) : messages
  const lastTurn = lastUserIdx >= 0 ? messages.slice(lastUserIdx) : []
  const showWork = work && (processing || work.stage === 'error')
  const canSend = !processing && input.trim().length > 0 && status.available

  const renderMsg = (m: ChatMessage) =>
    m.role === 'user' ? <UserBubble key={m.id} text={m.content} /> : m.role === 'assistant' ? <AssistantBubble key={m.id} text={m.content} /> : null

  return (
    <div className="chat">
      <div className="chat-main">
        <header className="chat-header">
          <h1>Chat</h1>
          <div className="chat-tools">
            {messages.length > 0 && (
              <button className="btn ghost small" title="Start a new chat (this one is saved in history)" disabled={processing} onClick={resetView}>
                <Icon name="plus" size={14} /> New chat
              </button>
            )}
            <button className={`icon-btn${showHistory ? ' on' : ''}`} title="Toggle chat history" onClick={() => setShowHistory((v) => !v)}>
              <Icon name="clock" />
            </button>
            <button className={`icon-btn${showDebug ? ' on' : ''}`} title="Toggle debug panel" onClick={() => setShowDebug((v) => !v)}>
              <Icon name="bug" />
            </button>
            <button className={`icon-btn${showMemory ? ' on' : ''}`} title="Toggle memory panel" onClick={() => setShowMemory((v) => !v)}>
              <Icon name="brain" />
            </button>
          </div>
        </header>

        <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
          <div className="chat-transcript">
            {messages.length === 0 && !processing ? (
              <Welcome onPick={(p) => void send(p)} disabled={!status.available} />
            ) : (
              <>
                {before.map(renderMsg)}
                <div ref={lastTurnRef} className="chat-turn">
                  {lastTurn.map(renderMsg)}
                  {processing && streamText && <AssistantBubble text={streamText} streaming />}
                  {showWork && <WorkStatusCard work={work} active={processing} />}
                  {!processing && <Suggestions items={suggestions} onPick={pickSuggestion} />}
                </div>
                <div style={{ height: spacer }} />
              </>
            )}
          </div>
        </div>
        {!atEdge && messages.length > 0 && (
          <button className="chat-jump" onClick={scrollToBottom}>
            <Icon name="down" size={14} /> Jump to latest
          </button>
        )}

        <div className="chat-composer">
          {!status.available && <div className="chat-unavailable">{status.availabilityMessage}</div>}
          <textarea
            ref={inputRef}
            value={input}
            rows={Math.min(8, Math.max(2, input.split('\n').length))}
            placeholder="Ask about your Dayflow data..."
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send(input)
              } else if (e.key === 'Enter' && e.altKey) {
                e.preventDefault()
                const el = e.currentTarget
                const { selectionStart: s, selectionEnd: en } = el
                const next = `${input.slice(0, s)}\n${input.slice(en)}`
                setInput(next)
                requestAnimationFrame(() => el.setSelectionRange(s + 1, s + 1))
              }
            }}
          />
          <div className="chat-composer-bar">
            <span className="chat-provider" title="Change the provider in Settings">
              {PROVIDER_LABEL[settings.provider] ?? status.providerLabel}
            </span>
            <div className="chat-composer-right">
              {processing && (
                <span className="chat-answering">
                  <span className="spinner" /> Answering
                </span>
              )}
              {processing ? (
                <button className="chat-send stop" title="Stop" onClick={cancel}>
                  <Icon name="stop" />
                </button>
              ) : (
                <button className="chat-send" title="Send" disabled={!canSend} onClick={() => void send(input)}>
                  <Icon name="send" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {showHistory && (
        <HistoryPanel
          conversations={conversations}
          currentId={conversationId}
          disabled={processing}
          onSelect={(id) => void openConversation(id)}
          onDelete={(id) => void deleteConversation(id)}
          onNew={resetView}
        />
      )}
      {showMemory && (
        <MemoryPanel
          stored={memory}
          draft={memoryDraft}
          onDraft={setMemoryDraft}
          onSave={() =>
            void call<ChatMemory>('chat:saveMemory', memoryDraft).then((m) => {
              setMemory(m)
              setMemoryDraft(m.text)
            })
          }
          onReload={() =>
            void call<ChatMemory>('chat:getMemory').then((m) => {
              setMemory(m)
              setMemoryDraft(m.text)
            })
          }
          onClear={() =>
            void call<ChatMemory>('chat:clearMemory').then((m) => {
              setMemory(m)
              setMemoryDraft('')
            })
          }
        />
      )}
      {showDebug && <DebugPanel entries={debug} onClear={() => setDebug([])} />}
    </div>
  )
}

function Welcome({ onPick, disabled }: { onPick: (p: string) => void; disabled: boolean }) {
  return (
    <div className="chat-welcome">
      <h2>Ask about your Dayflow data</h2>
      <p className="muted">Ask questions, analyze your timeline, and generate charts/graphs.</p>
      <p className="chat-note">I remember your response preferences, so feel free to teach me your style.</p>
      <div className="chat-try">Try one of these</div>
      {PROMPTS.map((p, i) => (
        <button key={p} className="chat-prompt" style={{ animationDelay: `${i * 45}ms` }} disabled={disabled} onClick={() => onPick(p)}>
          {p}
        </button>
      ))}
    </div>
  )
}

function BetaGate({ status, onAccept }: { status: ChatStatus; onAccept: () => void }) {
  const ready = status.hasEnoughData && status.available
  const hours = Math.min(status.requiredHours, Math.floor(status.analyzedHours))
  const button = !status.hasEnoughData ? 'Keep recording to unlock' : !status.available ? 'Configure a runtime to continue' : 'Unlock Beta'
  return (
    <div className="chat chat-gate">
      <div className="chat-gate-card">
        <div className="chat-gate-title">
          <h1>Unlock Beta</h1>
          <span className="chat-beta">BETA</span>
        </div>
        <p>Chat lets you ask questions about your Dayflow activity and get summaries, comparisons, and insights.</p>
        <p className="muted">Please send feedback if you see any bugs or weird behavior!</p>
        {!status.hasEnoughData ? (
          <div className="notice">
            <b>{status.requiredHours} hours of timeline data required</b>
            <div>
              Chat unlocks after Dayflow has analyzed enough activity. {hours} of {status.requiredHours} hours
            </div>
          </div>
        ) : status.available ? (
          <div className="notice ok">{status.providerLabel} is ready</div>
        ) : (
          <div className="notice err">
            <b>AI provider required</b>
            <div>{status.availabilityMessage}</div>
          </div>
        )}
        <button className="btn" disabled={!ready} onClick={onAccept}>
          {button}
        </button>
        <div className="chat-gate-privacy">
          <b>Privacy Note</b>
          <div>
            Your questions, and the timeline data the assistant reads to answer them, are sent only to the AI provider selected in
            Settings. Chats are stored locally in your Dayflow database.
          </div>
        </div>
      </div>
    </div>
  )
}
