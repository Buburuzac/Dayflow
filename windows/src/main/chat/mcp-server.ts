// Minimal stdio MCP server exposing the chat tools (fetchTimeline / fetchObservations) to the
// Claude Code and Codex CLIs. JSON-RPC 2.0, one message per line, no dependencies.
// Run as: ELECTRON_RUN_AS_NODE=1 <electron.exe> mcp-server.js <path to chunks.sqlite>
// (or `node --experimental-strip-types src/main/chat/mcp-server.ts <db>` in development).
// The database is opened read-only.

import { DatabaseSync } from 'node:sqlite'
import { createInterface } from 'node:readline'
import { executeTool, jsonSchemaTools } from './tools.ts'

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

interface RpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

export function handleRpc(req: RpcRequest, getDb: () => DatabaseSync): unknown | null {
  const id = req.id
  const isNotification = id === undefined || id === null
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id, result })
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } })
  switch (req.method) {
    case 'initialize': {
      const asked = typeof req.params?.protocolVersion === 'string' ? req.params.protocolVersion : ''
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'dayflow', version: '1.0.0' },
        instructions: 'Read-only access to the Dayflow work journal (timeline cards and raw observations).',
      })
    }
    case 'ping':
      return isNotification ? null : reply({})
    case 'tools/list':
      return reply({
        tools: jsonSchemaTools().map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.parameters,
          annotations: { readOnlyHint: true, openWorldHint: false },
        })),
      })
    case 'tools/call': {
      const name = String(req.params?.name ?? '')
      let res
      try {
        res = executeTool(getDb(), name, req.params?.arguments ?? {})
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        res = { summary: message, error: { code: 'database_error', message } }
      }
      return reply({ content: [{ type: 'text', text: JSON.stringify(res) }], isError: Boolean(res.error) })
    }
    case 'resources/list':
      return reply({ resources: [] })
    case 'prompts/list':
      return reply({ prompts: [] })
    default:
      if (isNotification) return null
      return fail(-32601, `Method not found: ${req.method}`)
  }
}

function main(): void {
  const dbPath = process.argv[2]
  if (!dbPath) {
    process.stderr.write('usage: mcp-server <path to chunks.sqlite>\n')
    process.exit(2)
  }
  let db: DatabaseSync | null = null
  const getDb = () => {
    if (!db) {
      db = new DatabaseSync(dbPath, { readOnly: true })
      db.exec('PRAGMA busy_timeout = 5000;')
    }
    return db
  }
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', (line) => {
    const t = line.trim()
    if (!t) return
    let msg: unknown
    try {
      msg = JSON.parse(t)
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      return
    }
    const batch = Array.isArray(msg) ? (msg as RpcRequest[]) : [msg as RpcRequest]
    const out = batch.map((r) => handleRpc(r, getDb)).filter((r) => r !== null)
    if (out.length) send(Array.isArray(msg) ? out : out[0])
  })
  rl.on('close', () => {
    try {
      db?.close()
    } catch {
      /* ignore */
    }
    process.exit(0)
  })
}

// Only start when executed directly (not when imported by tests).
const entry = process.argv[1] ?? ''
if (/mcp-server\.(js|cjs|mjs|ts)$/i.test(entry)) main()
