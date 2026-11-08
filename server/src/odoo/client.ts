import { parseResponse, serializeCall, XmlRpcFault, type XmlRpcValue } from './xmlrpc'

export interface OdooCreds {
  url: string
  db: string
  login: string
  apiKey: string
}

export class OdooError extends Error {
  constructor(
    message: string,
    public readonly kind: 'network' | 'auth' | 'fault' | 'protocol',
  ) {
    super(message)
  }
}

/** Odoo 15 external API over XML-RPC (`/xmlrpc/2/common`, `/xmlrpc/2/object`). */
export class OdooClient {
  private uid: number | null = null
  constructor(
    private readonly creds: OdooCreds,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 20_000,
  ) {}

  private async call(service: 'common' | 'object', method: string, params: unknown[]): Promise<XmlRpcValue> {
    const base = this.creds.url.replace(/\/+$/, '')
    let res: Response
    try {
      res = await this.fetchImpl(`${base}/xmlrpc/2/${service}`, {
        method: 'POST',
        headers: { 'content-type': 'text/xml; charset=utf-8' },
        body: serializeCall(method, params),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (e) {
      throw new OdooError(`cannot reach Odoo: ${(e as Error).message}`, 'network')
    }
    const text = await res.text()
    if (!res.ok) throw new OdooError(`Odoo HTTP ${res.status}`, 'protocol')
    try {
      return parseResponse(text)
    } catch (e) {
      if (e instanceof XmlRpcFault) {
        // first line only: Odoo puts the server traceback in faultString
        const first = e.faultString.split('\n').filter(Boolean).slice(-1)[0] ?? 'Odoo error'
        throw new OdooError(first.slice(0, 500), 'fault')
      }
      throw new OdooError('invalid XML-RPC response', 'protocol')
    }
  }

  version(): Promise<Record<string, XmlRpcValue>> {
    return this.call('common', 'version', []) as Promise<Record<string, XmlRpcValue>>
  }

  async authenticate(): Promise<number> {
    if (this.uid) return this.uid
    const uid = await this.call('common', 'authenticate', [this.creds.db, this.creds.login, this.creds.apiKey, {}])
    if (typeof uid !== 'number' || uid <= 0) throw new OdooError('Odoo authentication failed (check db, login and API key)', 'auth')
    this.uid = uid
    return uid
  }

  async executeKw(model: string, method: string, args: unknown[], kwargs: Record<string, unknown> = {}): Promise<XmlRpcValue> {
    const uid = await this.authenticate()
    return this.call('object', 'execute_kw', [this.creds.db, uid, this.creds.apiKey, model, method, args, kwargs])
  }

  searchRead(model: string, domain: unknown[], fields: string[], opts: { limit?: number; order?: string } = {}) {
    return this.executeKw(model, 'search_read', [domain], { fields, ...opts }) as Promise<Record<string, XmlRpcValue>[]>
  }

  async create(model: string, vals: Record<string, unknown>): Promise<number> {
    const id = await this.executeKw(model, 'create', [vals])
    if (typeof id !== 'number') throw new OdooError('unexpected create() result', 'protocol')
    return id
  }

  async write(model: string, ids: number[], vals: Record<string, unknown>): Promise<boolean> {
    return (await this.executeKw(model, 'write', [ids, vals])) === true
  }

  async exists(model: string, id: number): Promise<boolean> {
    const n = await this.executeKw(model, 'search_count', [[['id', '=', id]]])
    return typeof n === 'number' && n > 0
  }
}
