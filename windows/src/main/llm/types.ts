import type { AppSites, Distraction } from '../../shared/types.ts'

export interface ActivityCardData {
  startTime: string
  endTime: string
  category: string
  subcategory: string
  title: string
  summary: string
  detailedSummary: string
  distractions?: Distraction[]
  appSites?: AppSites
  /** Model's project guesses (only when the prompt listed projects). */
  projects?: LlmProjectGuess[]
}

export interface LlmProjectGuess {
  name: string
  /** 0..1 share of the card's time */
  share: number
  /** 0..1 */
  confidence: number
}

export interface Observation {
  startTs: number
  endTs: number
  observation: string
}

/** One frame handed to a provider: JPEG on disk plus its offset (seconds) from batch start. */
export interface Frame {
  path: string
  offsetSeconds: number
  /** Foreground window info captured with the frame, e.g. "chrome — Inbox - Gmail" */
  label?: string
}

export interface LLMCallLog {
  provider: string
  model: string | null
  operation: string
  status: 'success' | 'failure'
  latencyMs: number
  requestBody?: string
  responseBody?: string
  errorMessage?: string
}

export type CallLogger = (log: LLMCallLog) => void

/**
 * A provider does two things: turn frames into a text transcript, and generate text from a prompt.
 * Card generation, parsing and validation are shared on top of `generateText`.
 */
export interface LLMProvider {
  readonly id: string
  readonly model: string | null
  /** Returns raw model text for a prompt with images interleaved (each image preceded by its label). */
  generateWithImages?(prompt: string, frames: Frame[], operation: string, signal?: AbortSignal): Promise<string>
  /** Per-frame description path for small local models. */
  describeFrame?(prompt: string, frame: Frame, signal?: AbortSignal): Promise<string>
  /** `signal` aborts the request (HTTP) or kills the CLI process tree. */
  generateText(prompt: string, operation: string, expectJSON: boolean, signal?: AbortSignal): Promise<string>
}
