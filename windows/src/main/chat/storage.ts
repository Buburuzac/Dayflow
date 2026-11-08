// Chat history (StorageManager+ChatHistory.swift) and small chat state (memory blob, beta flag)
// in the main SQLite DB. Tables are created by this module.

import type { DatabaseSync } from 'node:sqlite'
import type { ChatMemory, ChatMessage, ChatRole, ConversationDetail, ConversationSummary } from '../../shared/chat-types.ts'
import type { ProviderId } from '../../shared/types.ts'
import { normalizeMemoryForSave } from './metadata.ts'

const ROLES: ChatRole[] = ['user', 'assistant', 'toolCall']
const PROVIDERS: ProviderId[] = ['gemini', 'openai_compatible', 'claude_cli', 'codex_cli']

export const MEMORY_KEY = 'dashboardChatMemoryBlob'
export const MEMORY_UPDATED_KEY = 'dashboardChatMemoryUpdatedAt'
export const BETA_KEY = 'hasChatBetaAccepted'

export interface StoredConversation extends ConversationDetail {
  cliSessionId: string | null
}

export class ChatStorage {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_conversations (
        id TEXT NOT NULL PRIMARY KEY,
        title TEXT NOT NULL,
        provider TEXT NOT NULL,
        cli_session_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_conversations_updated ON chat_conversations(updated_at DESC);
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT NOT NULL PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        sort_order INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation ON chat_messages(conversation_id, sort_order);
      CREATE TABLE IF NOT EXISTS chat_state (
        key TEXT NOT NULL PRIMARY KEY,
        value TEXT
      );
    `)
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const r = fn()
      this.db.exec('COMMIT')
      return r
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  saveConversation(c: {
    id: string
    title: string
    provider: ProviderId
    cliSessionId: string | null
    createdAt: number
    messages: ChatMessage[]
  }): void {
    if (c.messages.length === 0) return
    const now = Math.floor(Date.now() / 1000)
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO chat_conversations (id, title, provider, cli_session_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET title = excluded.title, provider = excluded.provider,
             cli_session_id = excluded.cli_session_id, updated_at = excluded.updated_at`,
        )
        .run(c.id, c.title, c.provider, c.cliSessionId, c.createdAt, now)
      this.db.prepare('DELETE FROM chat_messages WHERE conversation_id = ?').run(c.id)
      const ins = this.db.prepare(
        'INSERT INTO chat_messages (id, conversation_id, role, content, created_at, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
      )
      c.messages.forEach((m, i) => ins.run(m.id, c.id, m.role, m.content, m.createdAt, i))
    })
  }

  private static mapSummary(r: Record<string, unknown>): ConversationSummary {
    const p = String(r.provider) as ProviderId
    return {
      id: String(r.id),
      title: String(r.title),
      provider: PROVIDERS.includes(p) ? p : 'gemini',
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    }
  }

  listConversations(): ConversationSummary[] {
    return (this.db.prepare('SELECT * FROM chat_conversations ORDER BY updated_at DESC').all() as Array<Record<string, unknown>>).map(
      ChatStorage.mapSummary,
    )
  }

  loadConversation(id: string): StoredConversation | null {
    const r = this.db.prepare('SELECT * FROM chat_conversations WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!r) return null
    const messages = (
      this.db.prepare('SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY sort_order ASC').all(id) as Array<Record<string, unknown>>
    )
      .filter((m) => ROLES.includes(String(m.role) as ChatRole))
      .map((m) => ({ id: String(m.id), role: String(m.role) as ChatRole, content: String(m.content), createdAt: Number(m.created_at) }))
    return { ...ChatStorage.mapSummary(r), cliSessionId: r.cli_session_id == null ? null : String(r.cli_session_id), messages }
  }

  deleteConversation(id: string): void {
    this.tx(() => {
      this.db.prepare('DELETE FROM chat_messages WHERE conversation_id = ?').run(id)
      this.db.prepare('DELETE FROM chat_conversations WHERE id = ?').run(id)
    })
  }

  // ---- key/value state ----

  getState(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM chat_state WHERE key = ?').get(key) as { value: string | null } | undefined
    return r?.value ?? null
  }

  setState(key: string, value: string | null): void {
    if (value === null) this.db.prepare('DELETE FROM chat_state WHERE key = ?').run(key)
    else this.db.prepare('INSERT INTO chat_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  // ---- memory (§6.3) ----

  loadMemory(): ChatMemory {
    const text = (this.getState(MEMORY_KEY) ?? '').trim()
    const at = this.getState(MEMORY_UPDATED_KEY)
    return { text, updatedAt: text && at ? Number(at) : null }
  }

  saveMemory(text: string): ChatMemory {
    const t = normalizeMemoryForSave(text)
    if (!t) return this.clearMemory()
    this.setState(MEMORY_KEY, t)
    this.setState(MEMORY_UPDATED_KEY, String(Date.now()))
    return this.loadMemory()
  }

  clearMemory(): ChatMemory {
    this.setState(MEMORY_KEY, null)
    this.setState(MEMORY_UPDATED_KEY, null)
    return { text: '', updatedAt: null }
  }

  /** Completed analysis batches (the 10-hour unlock requirement counts these). */
  analyzedBatchCount(): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM analysis_batches WHERE status = 'analyzed'").get() as { n: number }
    return Number(r.n)
  }
}
