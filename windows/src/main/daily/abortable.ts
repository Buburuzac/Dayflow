// Cancellable provider calls for the Daily features.
//
// LLMProvider.generateText has no signal parameter yet; the signal is passed as a 4th argument so
// providers that accept it (see the note in the Daily fixes) actually stop their request or CLI
// process. Either way the returned promise rejects with "Cancelled" as soon as the signal fires,
// so callers never use a cancelled answer.

import type { LLMProvider } from '../llm/types.ts'

export class CancelledError extends Error {
  constructor() {
    super('Cancelled')
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CancelledError()
}

type GenerateWithSignal = (prompt: string, operation: string, expectJSON: boolean, signal?: AbortSignal) => Promise<string>

export function generateTextAbortable(
  provider: LLMProvider,
  prompt: string,
  operation: string,
  expectJSON: boolean,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (signal?.aborted) return Promise.reject(new CancelledError())
  const call = (provider.generateText as GenerateWithSignal).call(provider, prompt, operation, expectJSON, signal)
  if (!signal) return call
  return new Promise<string>((resolve, reject) => {
    const onAbort = () => reject(new CancelledError())
    signal.addEventListener('abort', onAbort, { once: true })
    call.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) reject(new CancelledError())
        else resolve(v)
      },
      (err) => {
        signal.removeEventListener('abort', onAbort)
        reject(signal.aborted ? new CancelledError() : err)
      },
    )
  })
}
