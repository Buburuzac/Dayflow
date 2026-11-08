// Small GitHub-flavoured Markdown renderer for chat answers: headings, paragraphs, emphasis,
// inline code, links (http/https/mailto only), nested + task lists, tables, blockquotes,
// fenced code blocks with a language label and copy button, thematic breaks.

import { type ReactNode, useState } from 'react'

type Block =
  | { t: 'heading'; level: number; text: string }
  | { t: 'para'; text: string }
  | { t: 'code'; lang: string; code: string }
  | { t: 'hr' }
  | { t: 'quote'; blocks: Block[] }
  | { t: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { t: 'table'; header: string[]; align: Array<'left' | 'center' | 'right' | null>; rows: string[][] }

interface ListItem {
  task: boolean | null
  blocks: Block[]
}

const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)?.*$/

function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
}

function isTableSep(line: string): boolean {
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) && line.includes('-')
}

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }
    const fence = FENCE_RE.exec(line)
    if (fence) {
      const marker = fence[1]
      const lang = fence[2] ?? ''
      const code: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(marker)) code.push(lines[i++])
      i++
      blocks.push({ t: 'code', lang, code: code.join('\n') })
      continue
    }
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (h) {
      blocks.push({ t: 'heading', level: h[1].length, text: h[2] })
      i++
      continue
    }
    if (HR_RE.test(line)) {
      blocks.push({ t: 'hr' })
      i++
      continue
    }
    if (/^\s{0,3}>/.test(line)) {
      const q: string[] = []
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) q.push(lines[i++].replace(/^\s{0,3}>\s?/, ''))
      blocks.push({ t: 'quote', blocks: parseBlocks(q.join('\n')) })
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = splitRow(line)
      const align = splitRow(lines[i + 1]).map((c) =>
        c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null,
      )
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(splitRow(lines[i++]))
      blocks.push({ t: 'table', header, align, rows })
      continue
    }
    const li = LIST_RE.exec(line)
    if (li) {
      const baseIndent = li[1].length
      const ordered = /\d/.test(li[2])
      const items: ListItem[] = []
      let cur: string[] | null = null
      const finish = () => {
        if (!cur) return
        let first = cur[0]
        let task: boolean | null = null
        const tm = /^\[([ xX])\]\s+(.*)$/.exec(first)
        if (tm) {
          task = tm[1] !== ' '
          first = tm[2]
        }
        items.push({ task, blocks: parseBlocks([first, ...cur.slice(1)].join('\n')) })
        cur = null
      }
      while (i < lines.length) {
        const l = lines[i]
        const m = LIST_RE.exec(l)
        if (m && m[1].length <= baseIndent + 1 && /\d/.test(m[2]) === ordered) {
          finish()
          cur = [m[3]]
          i++
          continue
        }
        if (m && m[1].length <= baseIndent + 1) break // different list type at same level
        if (!l.trim()) {
          // A blank line ends the list unless the next line is indented or another item.
          const next = lines[i + 1]
          if (next !== undefined && (/^\s{2,}\S/.test(next) || (LIST_RE.exec(next)?.[1].length ?? 99) <= baseIndent + 1)) {
            cur?.push('')
            i++
            continue
          }
          break
        }
        if (/^\s{2,}/.test(l) || (cur && !m && !HR_RE.test(l) && !/^\s{0,3}(#|>|```)/.test(l))) {
          // Continuation / nested content: strip the item's indentation.
          cur?.push(l.replace(new RegExp(`^\\s{0,${baseIndent + 4}}`), ''))
          i++
          continue
        }
        break
      }
      finish()
      blocks.push({ t: 'list', ordered, start: ordered ? parseInt(li[2], 10) || 1 : 1, items })
      continue
    }
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !FENCE_RE.test(lines[i]) &&
      !/^\s{0,3}(#{1,6}\s|>)/.test(lines[i]) &&
      !HR_RE.test(lines[i]) &&
      !(para.length > 0 && LIST_RE.test(lines[i]))
    ) {
      para.push(lines[i++])
    }
    if (para.length === 0) para.push(lines[i++])
    blocks.push({ t: 'para', text: para.join('\n') })
  }
  return blocks
}

/** Allowed link targets: http/https/mailto; bare hosts get https://. Others → null. */
export function safeHref(url: string): string | null {
  const u = url.trim()
  if (/^(https?:|mailto:)/i.test(u)) return u
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return null
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(u)) return `https://${u}`
  return null
}

const INLINE_RE =
  /(`+)([\s\S]*?[^`])\1(?!`)|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*([^*\s][^*]*?)\*|(?<![\w])_([^_\s][^_]*?)_(?![\w])|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|( {2,}\n|\\\n)/g

function inline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let n = 0
  INLINE_RE.lastIndex = 0
  const re = new RegExp(INLINE_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const k = `${key}-${n++}`
    if (m[1]) out.push(<code key={k}>{m[2].trim()}</code>)
    else if (m[3] !== undefined) {
      const href = safeHref(m[4])
      out.push(
        href ? (
          <a key={k} href={href} target="_blank" rel="noreferrer">
            {inline(m[3], k)}
          </a>
        ) : (
          <span key={k}>{inline(m[3], k)}</span>
        ),
      )
    } else if (m[5] !== undefined || m[6] !== undefined) out.push(<strong key={k}>{inline(m[5] ?? m[6], k)}</strong>)
    else if (m[7] !== undefined) out.push(<del key={k}>{inline(m[7], k)}</del>)
    else if (m[8] !== undefined || m[9] !== undefined) out.push(<em key={k}>{inline(m[8] ?? m[9], k)}</em>)
    else if (m[10] !== undefined) {
      out.push(
        <a key={k} href={m[10]} target="_blank" rel="noreferrer">
          {m[10]}
        </a>,
      )
    } else if (m[11] !== undefined) out.push(<br key={k} />)
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span>{lang || 'text'}</span>
        <button
          className="md-copy"
          onClick={() => {
            void navigator.clipboard.writeText(code)
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  )
}

function renderBlocks(blocks: Block[], key: string): ReactNode[] {
  return blocks.map((b, idx) => {
    const k = `${key}.${idx}`
    switch (b.t) {
      case 'heading': {
        const level = Math.min(4, b.level)
        const H = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4'
        return <H key={k} className="md-h">{inline(b.text, k)}</H>
      }
      case 'para':
        // Soft line breaks render as spaces (GFM); hard breaks are handled by `inline`.
        return <p key={k}>{inline(b.text, k).map((n) => (typeof n === 'string' ? n.replace(/\n/g, ' ') : n))}</p>
      case 'code':
        return <CodeBlock key={k} lang={b.lang} code={b.code} />
      case 'hr':
        return <hr key={k} />
      case 'quote':
        return <blockquote key={k}>{renderBlocks(b.blocks, k)}</blockquote>
      case 'list': {
        const items = b.items.map((it, j) => (
          <li key={`${k}-${j}`} className={it.task !== null ? 'md-task' : undefined}>
            {it.task !== null && <input type="checkbox" checked={it.task} readOnly />}
            {renderBlocks(it.blocks, `${k}-${j}`)}
          </li>
        ))
        return b.ordered ? (
          <ol key={k} start={b.start}>
            {items}
          </ol>
        ) : (
          <ul key={k}>{items}</ul>
        )
      }
      case 'table':
        return (
          <div key={k} className="md-table-wrap">
            <table>
              <thead>
                <tr>
                  {b.header.map((c, j) => (
                    <th key={j} style={{ textAlign: b.align[j] ?? undefined }}>
                      {inline(c, `${k}h${j}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, ri) => (
                  <tr key={ri}>
                    {b.header.map((_, j) => (
                      <td key={j} style={{ textAlign: b.align[j] ?? undefined }}>
                        {inline(r[j] ?? '', `${k}r${ri}c${j}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
    }
  })
}

export function Markdown({ text }: { text: string }) {
  return <div className="md">{renderBlocks(parseBlocks(text), 'b')}</div>
}
