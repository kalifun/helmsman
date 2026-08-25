// 轻量语法高亮（零依赖）：注释 / 字符串 / 关键字 / 数字。
// 正则 tokenize 逐行处理；字符串/注释优先匹配，其内部不误染关键字。
// 覆盖 ts/js/jsx/tsx/css/json/html/py/md/bash 常见语法；未知语言降级为纯文本（不崩）。
import type { ReactNode } from 'react'

const KW = [
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch',
  'case', 'break', 'continue', 'new', 'class', 'extends', 'import', 'export', 'from', 'default',
  'try', 'catch', 'finally', 'throw', 'async', 'await', 'yield', 'typeof', 'instanceof', 'in',
  'of', 'this', 'super', 'static', 'get', 'set', 'true', 'false', 'null', 'undefined', 'void',
  'interface', 'type', 'enum', 'implements', 'public', 'private', 'protected', 'readonly',
  'def', 'elif', 'lambda', 'pass', 'with', 'assert', 'raise', 'except', 'global', 'nonlocal',
  'package', 'func', 'go', 'select', 'struct', 'defer', 'range', 'chan', 'match', 'fn', 'let',
  'mut', 'use', 'mod', 'impl', 'trait', 'where', 'pub', 'html', 'body', 'div', 'span', 'head',
] as const

const KW_RE = new RegExp(`\\b(?:${KW.join('|')})\\b`, 'g')

/** 注释起始符（按语言；bash/md 的 # 与 py 的 # 冲突不大，通用处理） */
const COM_STARTS = ['//', '/*', '*/', '#', '<!--', '-->', '--']

interface Token { kind: 'str' | 'com' | 'kw' | 'num' | 'plain'; text: string }

const STR_RE = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g

/**
 * 单行 tokenize：先标记字符串与注释区间（不重叠），再在剩余区间匹配关键字/数字。
 * 返回 { tokens, comToEnd } —— comToEnd 表示该行在行内注释后结束（剩余全为注释）。
 */
function tokenizeLine(line: string): { tokens: Token[]; comToEnd: boolean } {
  const tokens: Token[] = []
  const zones: Array<{ start: number; end: number; kind: 'str' | 'com' }> = []
  let comToEnd = false

  // ① 字符串（含行内模板）
  STR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = STR_RE.exec(line))) {
    zones.push({ start: m.index, end: m.index + m[0].length, kind: 'str' })
  }
  // ② 行内注释（找最早出现的注释起始符）
  let comStart = -1
  for (const c of COM_STARTS) {
    const i = line.indexOf(c)
    if (i >= 0 && (comStart === -1 || i < comStart)) comStart = i
  }
  if (comStart >= 0) {
    // 注释起始若在字符串内则忽略（如 "//" 出现在字符串里）
    const inStr = zones.some((z) => z.kind === 'str' && comStart >= z.start && comStart < z.end)
    if (!inStr) {
      zones.push({ start: comStart, end: line.length, kind: 'com' })
      comToEnd = true
    }
  }
  zones.sort((a, b) => a.start - b.start)

  // ③ 在非 zone 区间匹配关键字/数字
  let pos = 0
  const push = (s: string, kind: Token['kind']) => { if (s) tokens.push({ text: s, kind }) }
  for (const z of zones) {
    push(line.slice(pos, z.start), 'plain')
    push(line.slice(z.start, z.end), z.kind)
    pos = z.end
  }
  push(line.slice(pos), 'plain')

  // ④ 关键字/数字只在 plain 段内匹配
  const out: Token[] = []
  for (const t of tokens) {
    if (t.kind !== 'plain') { out.push(t); continue }
    KW_RE.lastIndex = 0
    const NUM_RE = /\b\d+(?:\.\d+)?\b/g
    // 合并匹配：关键字或数字，按位置先后
    let k: RegExpExecArray | null
    let n: RegExpExecArray | null
    let cursor = 0
    const parts: Array<{ start: number; end: number; kind: 'kw' | 'num' }> = []
    for (;;) {
      k = KW_RE.exec(t.text)
      n = NUM_RE.exec(t.text)
      const nextK = k ? { start: k.index, end: k.index + k[0].length, kind: 'kw' as const } : null
      const nextN = n ? { start: n.index, end: n.index + n[0].length, kind: 'num' as const } : null
      // 找最近的下一个
      const cands: Array<{ start: number; end: number; kind: 'kw' | 'num' }> = []
      if (nextK) cands.push(nextK)
      if (nextN) cands.push(nextN)
      if (cands.length === 0) break
      cands.sort((a, b) => a.start - b.start)
      const c = cands[0]
      // 重置另一个正则到本次位置之后，避免漏匹配
      if (c === nextK && n) NUM_RE.lastIndex = c.end
      if (c === nextN && k) KW_RE.lastIndex = c.end
      if (c.start < cursor) { // 已消费区域，跳到更远
        if (c === nextK) KW_RE.lastIndex = Math.max(KW_RE.lastIndex, c.end)
        else NUM_RE.lastIndex = Math.max(NUM_RE.lastIndex, c.end)
        continue
      }
      parts.push(c)
      cursor = c.end
      if (c === nextK) NUM_RE.lastIndex = Math.max(NUM_RE.lastIndex, c.end)
      else KW_RE.lastIndex = Math.max(KW_RE.lastIndex, c.end)
    }
    let p = 0
    for (const pt of parts) {
      if (pt.start > p) out.push({ text: t.text.slice(p, pt.start), kind: 'plain' })
      out.push({ text: t.text.slice(pt.start, pt.end), kind: pt.kind })
      p = pt.end
    }
    if (p < t.text.length) out.push({ text: t.text.slice(p), kind: 'plain' })
  }
  return { tokens: out, comToEnd }
}

const KIND_CLS: Record<Token['kind'], string> = {
  str: 'hl-str', com: 'hl-com', kw: 'hl-kw', num: 'hl-num', plain: '',
}

/** 代码 → 高亮片段（按行；行尾注释整行染灰） */
export function highlightLine(line: string): ReactNode {
  const { tokens, comToEnd } = tokenizeLine(line)
  const nodes: ReactNode[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    const cls = comToEnd && i >= tokens.findIndex((x) => x.kind === 'com') ? 'hl-com' : KIND_CLS[t.kind]
    if (!cls) nodes.push(t.text)
    else nodes.push(<span key={i} className={cls}>{t.text}</span>)
  }
  return nodes.length ? nodes : null
}
