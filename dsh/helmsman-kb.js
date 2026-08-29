// [helmsman] D3-4 知识库插件（引擎内化）。
// 迁移点：
//   - retrieveHybrid / makeNote / buildDistillPrompt / parseDistillJson：纯函数原样搬
//   - distillWithAgent：ACP 会话（sessionNew+prompt+轮询读JSONL）→ 引擎内 agents 直接驱动
//     （followup + whenIdle + session.events 直读，零轮询、零 ACP、零补丁）
// 存储：D3-4 阶段内存 Map（SQLite 搬迁留到 D3-4 完整版）。
// 接口：
//   GET  /api/kb/search?q=&project=   → [{id,title,summary,score}]
//   POST /api/kb/notes               → {note}（人工沉淀）
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'helmsman-kb'
export const inject = ['webServer', 'agents', 'sessions', 'helmsmanStorage']

// ---------- 纯函数：从 server-ts/kb.ts + distill.ts 原样搬（只去 node:fs/ACP 依赖） ----------

/** 规则检索（关键词匹配，融合排序）。 */
function deriveQueries(taskText) {
  const t = String(taskText ?? '').toLowerCase()
  const tokens = t.split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean)
  const seen = new Set()
  const out = []
  for (const tok of tokens) {
    if (tok.length < 2 || seen.has(tok)) continue
    seen.add(tok)
    out.push(tok)
  }
  return out.slice(0, 8)
}

/** 检索命中（简单规则版：标题/内容/关键词包含任一 query 即命中）。 */
function retrieve(notes, queries, opts = {}) {
  const limit = opts.limit ?? 5
  const hits = []
  for (const n of notes) {
    if (!n) continue
    let score = 0
    const title = (n.title ?? '').toLowerCase()
    const content = (n.content ?? []).join(' ').toLowerCase()
    const keywords = (n.keywords ?? []).join(' ').toLowerCase()
    const tags = (n.tags ?? []).join(' ').toLowerCase()
    for (const q of queries) {
      if (title.includes(q)) score += 3
      else if (keywords.includes(q)) score += 2
      else if (tags.includes(q)) score += 1.5
      else if (content.includes(q)) score += 1
    }
    if (score > 0) hits.push({ note: n, score })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, limit).map((h) => ({ note: h.note, score: h.score }))
}

function makeNote(input) {
  const t = Date.now()
  return {
    id: `kb-${t}-${Math.floor(Math.random() * 1e6)}`,
    project_id: input.projectId,
    title: input.title,
    content: input.content ?? [],
    tags: input.tags ?? [],
    keywords: input.keywords ?? [],
    summary: input.summary ?? '',
    links: input.links ?? [],
    source: { kind: input.sourceKind, ref: input.sourceRef },
    validFrom: t,
    validUntil: null,
    version: 1,
    trust: input.trust,
    createdAt: t,
    updatedAt: t,
  }
}

/** 提炼 prompt（有界：尾部 2000 字符 + 相关笔记 ≤3 条摘要）。 */
function buildDistillPrompt(input) {
  const lines = []
  lines.push('任务标题：' + (input.title ?? '').slice(0, 200))
  lines.push('')
  lines.push('任务输出（末尾）：')
  lines.push((input.tail ?? '').slice(0, 2000))
  if (input.related?.length > 0) {
    lines.push('')
    lines.push('相关笔记（摘要）：')
    for (const r of input.related.slice(0, 3)) {
      lines.push(`- ${r.title ?? ''}: ${(r.summary ?? '').slice(0, 200)}`)
    }
  }
  lines.push('')
  lines.push('请从任务输出中提炼一条结构化知识条目，严格输出 JSON：')
  lines.push('{"title":"简短标题","content":["要点1","要点2"],"keywords":["k1","k2"],"summary":"一句话总结"}')
  lines.push('若无值得沉淀的知识，输出 {"title":""}。只输出 JSON，不要其他文字。')
  return lines.join('\n')
}

/** 解析提炼 JSON（容错：剥掉代码块围栏/前后杂文）。 */
function parseDistillJson(text) {
  const t = String(text ?? '').trim()
  if (!t) return null
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = fenced ? fenced[1] : t
  try {
    const obj = JSON.parse(raw)
    if (!obj || typeof obj !== 'object') return null
    const title = typeof obj.title === 'string' ? obj.title : ''
    return {
      title,
      content: Array.isArray(obj.content) ? obj.content.filter((x) => typeof x === 'string').slice(0, 20) : [],
      keywords: Array.isArray(obj.keywords) ? obj.keywords.filter((x) => typeof x === 'string').slice(0, 10) : [],
      summary: typeof obj.summary === 'string' ? obj.summary : '',
    }
  } catch {
    return null
  }
}

// ---------- 引擎接点：distill 用 agents 直接驱动（替代 ACP） ----------

/**
 * 提炼：引擎内建 distill 会话 → followup → whenIdle → session.events 直读。
 * 替代 v1 的 acp.sessionNew + sessionPrompt + 轮询读 JSONL。
 */
async function distillWithEngine(ctx, input, timeoutMs = 120000) {
  const sid = SessionId(`distill-${randomUUID().slice(0, 12)}`)
  let dispose
  try {
    const prompt = buildDistillPrompt(input)
    const { agent, dispose: d } = await ctx.agents.create({
      sessionId: sid,
      meta: { cwd: input.cwd },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      setup: (agentCtx) => { /* distill 预设：无工具纯文本（D3-4 简化：不挂工具即纯文本） */ },
    })
    dispose = d
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }))
    await Promise.race([
      agent.whenIdle(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('distill timeout')), timeoutMs)),
    ])
    await ctx.sessions.flush(agent.session)
    const text = extractLastAssistantText(agent.session.events)
    if (!text) return null
    const parsed = parseDistillJson(text)
    if (parsed == null || parsed.title === '') return null
    return parsed
  } catch (e) {
    console.error('[helmsman-kb] distill 失败（回落规则版）:', e?.message ?? e)
    return null
  } finally {
    if (dispose) await dispose().catch(() => undefined)
  }
}

function extractLastAssistantText(events) {
  let text = ''
  for (const ev of events) {
    if (ev.type !== 'assistant/message') continue
    const msg = ev.message ?? ev.data?.message ?? {}
    text = (msg.content ?? [])
      .filter((b) => b?.type === 'text')
      .map((b) => b.text)
      .join('')
  }
  return text.trim()
}

// ---------- 插件主体：路由 + 内存存储 ----------

export function apply(ctx) {
  const { webServer } = ctx
  const storage = ctx.get('helmsmanStorage')?.storage
  // 笔记统一走 SQLite（listNotes 加载；无 project 时用固定默认遍历）
  const loadNotes = (project) => {
    if (!storage) return []
    if (project) return storage.listNotes(project)
    return storage.listNotes('default') // 无 project 过滤：默认库（前端总是传 project）
  }
  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const readBody = (req) => new Promise((resolve, reject) => {
    let buf = ''
    req.on('data', (c) => { buf += c; if (buf.length > 1e6) reject(new Error('body too large')) })
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}) } catch (e) { reject(e) } })
    req.on('error', reject)
  })

  // GET /api/kb/search?q=&project=
  webServer.register({
    kind: 'exact',
    path: '/api/kb/search',
    handler: (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost')
      const q = url.searchParams.get('q') ?? ''
      const project = url.searchParams.get('project')
      const pool = loadNotes(project)
      if (!q.trim()) return json(res, 200, [])
      const hits = retrieve(pool, deriveQueries(q), { limit: 8 })
      json(res, 200, hits.map((h) => ({
        id: h.note.id,
        title: h.note.title,
        summary: h.note.summary,
        score: h.score,
        project_id: h.note.project_id,
      })))
    },
  })

  // /api/kb/notes —— GET 列表（前端契约）+ POST 人工沉淀
  webServer.register({
    kind: 'exact',
    path: '/api/kb/notes',
    handler: async (req, res) => {
      if (req.method === 'GET') {
        const url = new URL(req.url ?? '', 'http://localhost')
        const project = url.searchParams.get('project')
        const list = loadNotes(project)
        // 有效笔记优先（未失效），按创建时间倒序
        list.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
        return json(res, 200, list)
      }
      if (req.method === 'POST') {
        try {
          const body = await readBody(req)
          const note = makeNote({
            projectId: body.project_id ?? 'default',
            title: body.title ?? '(无题)',
            content: body.content ?? [],
            tags: body.tags ?? [],
            keywords: body.keywords ?? [],
            summary: body.summary ?? '',
            sourceKind: body.source_kind ?? 'human',
            sourceRef: body.source_ref ?? '',
            trust: body.trust ?? 'human-approved',
          })
          if (storage) storage.upsertNote(note)
          return json(res, 201, { note })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
      }
      return json(res, 405, { error: 'method not allowed' })
    },
  })

  // POST /api/kb/notes/:id/invalidate —— 失效笔记
  webServer.register({
    kind: 'prefix',
    path: '/api/kb/notes',
    handler: (req, res) => {
      const pathname = (req.url ?? '').split('?')[0]
      const inv = pathname.match(/^\/api\/kb\/notes\/([^/]+)\/invalidate$/)
      if (inv && req.method === 'POST') {
        const n = storage ? storage.getNote(inv[1]) : undefined
        if (!n) return json(res, 404, { error: 'note not found' })
        if (storage) storage.invalidateNote(n.id, 'manual', Date.now())
        return json(res, 200, { ok: true })
      }
      // POST /api/kb/notes/:id/stable —— 钉进/移出稳定前缀
      const stable = pathname.match(/^\/api\/kb\/notes\/([^/]+)\/stable$/)
      if (stable && req.method === 'POST') {
        return (async () => {
          try {
            const body = await readBody(req)
            const n = storage ? storage.getNote(stable[1]) : undefined
            if (!n) return json(res, 404, { error: 'note not found' })
            const pinned = body.pinned === true
            n.tags = n.tags ?? []
            if (pinned && !n.tags.includes('stable')) n.tags.push('stable')
            if (!pinned) n.tags = n.tags.filter((t) => t !== 'stable')
            if (storage) storage.upsertNote(n)
            return json(res, 200, n)
          } catch (e) {
            return json(res, 500, { error: e?.message ?? String(e) })
          }
        })()
      }
      return json(res, 404, { error: 'not found' })
    },
  })

  // POST /api/kb/distill —— 任务 Done → 提炼 → 沉淀（完整闭环演示）
  webServer.register({
    kind: 'exact',
    path: '/api/kb/distill',
    handler: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
      try {
        const body = await readBody(req)
        const result = await distillWithEngine(ctx, {
          cwd: body.cwd ?? process.cwd(),
          title: body.title ?? '',
          tail: body.tail ?? '',
          related: body.related ?? [],
        })
        if (result == null) return json(res, 200, { skipped: true })
        const note = makeNote({
          projectId: body.project_id ?? 'default',
          title: result.title,
          content: result.content,
          tags: [],
          keywords: result.keywords,
          summary: result.summary,
          sourceKind: 'task',
          sourceRef: body.source_ref ?? '',
          trust: 'agent-generated',
        })
        if (storage) storage.upsertNote(note)
        json(res, 201, { note })
      } catch (e) {
        json(res, 500, { error: e?.message ?? String(e) })
      }
    },
  })

  console.log('[helmsman-kb] 知识库路由已注册：/api/kb/search /api/kb/notes /api/kb/distill')
}

export default { name, inject, apply }
