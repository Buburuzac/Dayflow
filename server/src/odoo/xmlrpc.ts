// Minimal XML-RPC (the subset Odoo uses): int, boolean, string, double, nil, array, struct, base64 (as string),
// dateTime (as string). Used both by the Odoo client and by the test mock server.

export type XmlRpcValue = null | boolean | number | string | XmlRpcValue[] | { [k: string]: XmlRpcValue }

export class XmlRpcFault extends Error {
  constructor(
    public readonly faultCode: number | string,
    public readonly faultString: string,
  ) {
    super(faultString)
  }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function serializeValue(v: unknown): string {
  if (v === null || v === undefined) return '<value><nil/></value>'
  if (typeof v === 'boolean') return `<value><boolean>${v ? 1 : 0}</boolean></value>`
  if (typeof v === 'number') {
    if (Number.isInteger(v) && Math.abs(v) < 2 ** 31) return `<value><int>${v}</int></value>`
    if (!Number.isFinite(v)) throw new Error('cannot serialize non-finite number')
    return `<value><double>${v}</double></value>`
  }
  if (typeof v === 'string') return `<value><string>${esc(v)}</string></value>`
  if (Array.isArray(v)) return `<value><array><data>${v.map(serializeValue).join('')}</data></array></value>`
  if (typeof v === 'object') {
    const members = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => `<member><name>${esc(k)}</name>${serializeValue(x)}</member>`)
      .join('')
    return `<value><struct>${members}</struct></value>`
  }
  throw new Error(`cannot serialize ${typeof v}`)
}

export function serializeCall(method: string, params: unknown[]): string {
  return `<?xml version="1.0"?><methodCall><methodName>${esc(method)}</methodName><params>${params
    .map((p) => `<param>${serializeValue(p)}</param>`)
    .join('')}</params></methodCall>`
}

export function serializeResponse(value: unknown): string {
  return `<?xml version="1.0"?><methodResponse><params><param>${serializeValue(value)}</param></params></methodResponse>`
}

export function serializeFault(code: number, message: string): string {
  return `<?xml version="1.0"?><methodResponse><fault>${serializeValue({ faultCode: code, faultString: message })}</fault></methodResponse>`
}

// ---- parsing: a tiny tokenizer producing an element tree ----

interface El {
  name: string
  children: El[]
  text: string
}

const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    const l = e.toLowerCase()
    if (l === 'amp') return '&'
    if (l === 'lt') return '<'
    if (l === 'gt') return '>'
    if (l === 'quot') return '"'
    if (l === 'apos') return "'"
    if (l.startsWith('#x')) return String.fromCodePoint(parseInt(l.slice(2), 16))
    return String.fromCodePoint(parseInt(l.slice(1), 10))
  })

function parseXml(xml: string): El {
  const root: El = { name: '#root', children: [], text: '' }
  const stack: El[] = [root]
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w.:-]*)[^>]*?(\/?)>|([^<]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1]
    if (m[1] !== undefined) top.text += m[1]
    else if (m[3]) {
      if (m[2] === '/') {
        if (stack.length <= 1 || top.name !== m[3]) throw new Error('malformed XML')
        stack.pop()
      } else {
        const el: El = { name: m[3], children: [], text: '' }
        top.children.push(el)
        if (m[4] !== '/') stack.push(el)
      }
    } else if (m[5] !== undefined) top.text += decode(m[5])
  }
  if (stack.length !== 1) throw new Error('malformed XML')
  return root
}

const child = (el: El, name: string) => el.children.find((c) => c.name === name)

function valueOf(v: El): XmlRpcValue {
  const t = v.children[0]
  if (!t) return v.text // untyped value = string
  switch (t.name) {
    case 'int':
    case 'i4':
    case 'i8':
      return parseInt(t.text.trim(), 10)
    case 'double':
      return parseFloat(t.text.trim())
    case 'boolean':
      return t.text.trim() === '1'
    case 'string':
    case 'base64':
    case 'dateTime.iso8601':
      return t.text
    case 'nil':
      return null
    case 'array': {
      const data = child(t, 'data')
      return (data?.children ?? []).filter((c) => c.name === 'value').map(valueOf)
    }
    case 'struct': {
      const out: Record<string, XmlRpcValue> = {}
      for (const m of t.children.filter((c) => c.name === 'member')) {
        const n = child(m, 'name')
        const val = child(m, 'value')
        if (n && val) out[n.text] = valueOf(val)
      }
      return out
    }
    default:
      throw new Error(`unsupported XML-RPC type ${t.name}`)
  }
}

export function parseResponse(xml: string): XmlRpcValue {
  const root = parseXml(xml)
  const resp = child(root, 'methodResponse')
  if (!resp) throw new Error('not an XML-RPC response')
  const fault = child(resp, 'fault')
  if (fault) {
    const f = valueOf(child(fault, 'value')!) as Record<string, XmlRpcValue>
    throw new XmlRpcFault(f.faultCode as number, String(f.faultString ?? 'fault'))
  }
  const param = child(child(resp, 'params') ?? { name: '', children: [], text: '' }, 'param')
  const v = param && child(param, 'value')
  if (!v) throw new Error('empty XML-RPC response')
  return valueOf(v)
}

export function parseCall(xml: string): { method: string; params: XmlRpcValue[] } {
  const root = parseXml(xml)
  const call = child(root, 'methodCall')
  if (!call) throw new Error('not an XML-RPC call')
  const method = child(call, 'methodName')?.text.trim() ?? ''
  const params = (child(call, 'params')?.children ?? [])
    .filter((c) => c.name === 'param')
    .map((p) => valueOf(child(p, 'value')!))
  return { method, params }
}
