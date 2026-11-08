// Types shared by the chat feature (main process, renderer, MCP server, tests).
// Channels: see src/main/features/chat.ts.

import type { ProviderId } from './types.ts'

export type ChatRole = 'user' | 'assistant' | 'toolCall'

export interface ChatMessage {
  id: string
  role: ChatRole
  /** Assistant content is the cleaned text (metadata blocks stripped, chart blocks kept). */
  content: string
  /** Epoch seconds */
  createdAt: number
}

export interface ConversationSummary {
  id: string
  title: string
  provider: ProviderId
  createdAt: number
  updatedAt: number
}

export interface ConversationDetail extends ConversationSummary {
  messages: ChatMessage[]
  /** Set while a turn on this conversation is still running (the view re-attaches to it). */
  activeTurn?: ActiveTurnSnapshot | null
}

/** Live state of a running turn, so a remounted view can resume showing it. */
export interface ActiveTurnSnapshot {
  turnId: string
  conversationId: string
  stage: ChatStage
  /** Visible streamed text so far */
  visible: string
  thinking: string
  tools: ToolRun[]
  error: string | null
}

export type ChatStage = 'thinking' | 'runningTools' | 'answering' | 'error'

export interface ToolRun {
  id: string
  command: string
  summary: string
  output: string
  state: 'running' | 'done' | 'failed'
}

export interface ChatSendRequest {
  /** Client-generated id that tags every streamed event of this turn. */
  turnId: string
  /** null for a new conversation */
  conversationId: string | null
  text: string
}

export interface ChatTurnResult {
  turnId: string
  conversationId: string
  messages: ChatMessage[]
  suggestions: string[]
  memory: ChatMemory
  error: string | null
  cancelled: boolean
}

export interface ChatMemory {
  text: string
  /** Epoch ms, null when not saved yet */
  updatedAt: number | null
}

export interface ChatStatus {
  provider: ProviderId
  providerLabel: string
  available: boolean
  /** Why the provider is not usable (empty when available) */
  availabilityMessage: string
  analyzedHours: number
  requiredHours: number
  hasEnoughData: boolean
  betaAccepted: boolean
  /** Most recently started turn that is still running, if any. */
  activeTurn: ActiveTurnSnapshot | null
}

export type ChatDebugKind = 'USER' | 'PROMPT' | 'RESPONSE' | 'TOOL DETECTED' | 'TOOL RESULT' | 'ERROR' | 'INFO'

/** Payload of the `chat:event` broadcast. */
export type ChatEvent =
  | { turnId: string; type: 'stage'; stage: ChatStage }
  | { turnId: string; type: 'thinking'; text: string }
  | { turnId: string; type: 'toolStart'; tool: ToolRun }
  | { turnId: string; type: 'toolEnd'; tool: ToolRun }
  /** Visible streaming text so far (metadata hidden); flushed at most every 50 ms. */
  | { turnId: string; type: 'text'; visible: string }
  | { turnId: string; type: 'error'; message: string }
  | { turnId: string; type: 'debug'; kind: ChatDebugKind; content: string; at: number }
  /** The turn finished; same payload chat:send resolves with (lets a re-attached view finish it). */
  | { turnId: string; type: 'done'; result: ChatTurnResult }

// ---- Tool payloads (fetchTimeline / fetchObservations) ----

export interface ToolRequestEcho {
  mode: 'date' | 'range'
  date: string | null
  startDate: string | null
  endDate: string | null
  includeDetailedSummary?: boolean
  limit: number | null
}

export interface ToolResponse {
  summary: string
  error?: { code: string; message: string }
  [key: string]: unknown
}
