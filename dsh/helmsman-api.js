// [helmsman] B1 业务 API 插件：projects/cards/chats 路由（读 helmsmanBoard 投影）。
// 兼容 v1 server-ts 的前端契约（web/src/api/client.ts + store/projection.ts）。
// 数据源：helmsmanBoard 投影（session/event 实时折叠），无独立持久化（B1 阶段内存）。
// 端点：
//   GET  /api/projects                 → [{id,name,path,card_count,counts}]
//   POST /api/projects                 {name,path} → {id}
//   GET  /api/projects/:pid            → {id,name,path,cards:{<cardId>:CardState}}
//   GET  /api/projects/:pid/cards      → CardSummary[]
//   POST /api/projects/:pid/cards      {title,...} → {card_id}
//   GET  /api/cards/:cardId            → CardDetail（含全部 executions）
//   GET  /api/tasks/:sid               → TaskState（执行/会话状态）
//   GET  /api/chats/:sid               → TaskState（简单会话）
//   GET  /api/projects/:pid/chats      → ChatSummary[]
export const name = 'helmsman-api'
export const inject = ['webServer', 'helmsmanBoard', 'helmsmanTasks']

export function apply(ctx) {
  const { webServer } = ctx
  const board = ctx.get('helmsmanBoard')
  const tasks = ctx.get('helmsmanTasks')
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
  const getProject = (pid) => board.projection.projects[pid]
  const getTask = (sid) => {
    const pid = board.projection.sessionProject[sid]
    if (!pid) return undefined
    const cardId = board.projection.sessionCard[sid]
    const proj = board.projection.projects[pid]
    if (!proj) return undefined
    if (cardId) return proj.cards[cardId]?.executions[sid]
    return proj.chats[sid]
  }
  /** 状态计数 [Pending, Running, Done, Failed, Cancelled]（按卡最新执行状态） */
  const countStatus = (p) => {
    const counts = [0, 0, 0, 0, 0]
    const idx = { Pending: 0, Running: 1, Done: 2, Failed: 3, Cancelled: 4 }
    for (const card of Object.values(p.cards)) {
      const order = card.exec_order.length ? card.exec_order : Object.keys(card.executions)
      const sid = order[order.length - 1]
      const exec = sid ? card.executions[sid] : undefined
      if (exec && idx[exec.status] !== undefined) counts[idx[exec.status]] += 1
    }
    return counts
  }

  // GET /api/projects —— 项目列表
  webServer.register({
    kind: 'exact',
    path: '/api/projects',
    handler: (req, res) => {
      if (req.method === 'GET') {
        const list = Object.values(board.projection.projects).map((p) => ({
          id: p.id,
          name: p.name,
          path: p.path,
          card_count: Object.keys(p.cards).length,
          counts: countStatus(p),
        }))
        return json(res, 200, list)
      }
      if (req.method === 'POST') {
        return (async () => {
          try {
            const body = await readBody(req)
            if (!body.name || !body.path) return json(res, 400, { error: 'name and path required' })
            const pid = body.id ?? `p-${Date.now().toString(36)}`
            board.ensureProject(pid, body.name, body.path)
            json(res, 201, { id: pid })
          } catch (e) {
            json(res, 500, { error: e?.message ?? String(e) })
          }
        })()
      }
      return json(res, 405, { error: 'method not allowed' })
    },
  })

  // GET /api/projects/:pid —— 项目详情（cards 是字典）
  webServer.register({
    kind: 'prefix',
    path: '/api/projects',
    handler: async (req, res) => {
      const pathname = (req.url ?? '').split('?')[0]
      const detail = pathname.match(/^\/api\/projects\/([^/]+)$/)
      if (detail && req.method === 'GET') {
        const p = getProject(decodeURIComponent(detail[1]))
        if (!p) return json(res, 404, { error: 'project not found' })
        return json(res, 200, { id: p.id, name: p.name, path: p.path, cards: p.cards })
      }
      // GET /api/projects/:pid/cards —— 卡列表（轻量）
      const cards = pathname.match(/^\/api\/projects\/([^/]+)\/cards$/)
      if (cards && req.method === 'GET') {
        const p = getProject(decodeURIComponent(cards[1]))
        if (!p) return json(res, 404, { error: 'project not found' })
        const list = Object.values(p.cards).map((c) => {
          const order = c.exec_order.length ? c.exec_order : Object.keys(c.executions)
          const sid = order[order.length - 1]
          const exec = sid ? c.executions[sid] : undefined
          return {
            id: c.id,
            title: c.title,
            description: c.description ?? '',
            kind: c.kind ?? 'task',
            milestone: c.milestone,
            execution_count: order.length,
            created_at: c.created_at,
            latest: exec ? {
              session_id: sid,
              status: exec.status,
              title: exec.title ?? null,
              started_at: exec.started_at ?? null,
              finished_at: exec.finished_at ?? null,
            } : null,
          }
        })
        return json(res, 200, list)
      }
      // POST /api/projects/:pid/cards —— 建卡（资产）+ 首代执行（建卡即自动跑）
      if (cards && req.method === 'POST') {
        try {
          const body = await readBody(req)
          const p = getProject(decodeURIComponent(cards[1]))
          if (!p) return json(res, 404, { error: 'project not found' })
          const cardId = body.id ?? `c-${Date.now().toString(36)}`
          board.ensureCard(p.id, {
            id: cardId,
            title: body.title ?? '(无题)',
            description: body.description ?? '',
            kind: body.kind ?? 'task',
            milestone: body.milestone ?? null,
            criteria: body.criteria ?? null,
            deps: body.deps ?? [],
            created_at: Date.now(),
          })
          return json(res, 201, { card_id: cardId })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
      }
      // GET /api/projects/:pid/chats —— 简单会话列表
      const chats = pathname.match(/^\/api\/projects\/([^/]+)\/chats$/)
      if (chats && req.method === 'GET') {
        const p = getProject(decodeURIComponent(chats[1]))
        if (!p) return json(res, 404, { error: 'project not found' })
        const list = Object.values(p.chats).map((t) => ({
          session_id: t.id,
          title: t.title ?? null,
          status: t.status,
          started_at: t.started_at ?? null,
          finished_at: t.finished_at ?? null,
        }))
        return json(res, 200, list)
      }
      return json(res, 404, { error: 'not found' })
    },
  })

  // GET /api/cards/:cardId —— 卡详情（全部执行代次）
  webServer.register({
    kind: 'prefix',
    path: '/api/cards',
    handler: (req, res) => {
      const pathname = (req.url ?? '').split('?')[0]
      const m = pathname.match(/^\/api\/cards\/([^/]+)$/)
      if (!m || req.method !== 'GET') return json(res, 404, { error: 'not found' })
      const cardId = decodeURIComponent(m[1])
      for (const p of Object.values(board.projection.projects)) {
        const card = p.cards[cardId]
        if (card) {
          return json(res, 200, { ...card, project_id: p.id, execution_count: card.exec_order.length })
        }
      }
      return json(res, 404, { error: 'card not found' })
    },
  })

  // /api/tasks* —— 统一路由（调 helmsmanTasks 服务）
  webServer.register({
    kind: 'prefix',
    path: '/api/tasks',
    handler: async (req, res) => {
      const pathname = (req.url ?? '').split('?')[0]
      // POST /api/tasks —— 建任务
      if (pathname === '/api/tasks' && req.method === 'POST') {
        try {
          const body = await readBody(req)
          if (!body.cwd || !body.brief) return json(res, 400, { error: 'cwd and brief required' })
          const { sid } = await tasks.createTask({
            cwd: body.cwd,
            brief: body.brief,
            preset: body.preset,
            project_id: body.project_id,
            card_id: body.card_id,
          })
          return json(res, 201, { session_id: sid })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
      }
      // POST /api/tasks/:sid/comments —— 评论 = 控制通道
      const comment = pathname.match(/^\/api\/tasks\/([^/]+)\/comments$/)
      if (comment && req.method === 'POST') {
        try {
          const body = await readBody(req)
          if (!body.text) return json(res, 400, { error: 'text required' })
          tasks.sendComment(decodeURIComponent(comment[1]), body.text)
          return json(res, 200, { ok: true })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
      }
      // GET /api/tasks/:sid —— 任务状态（前端契约：TaskState 投影形状）
      const detail = pathname.match(/^\/api\/tasks\/([^/]+)$/)
      if (detail && req.method === 'GET') {
        const t = getTask(decodeURIComponent(detail[1]))
        if (t) return json(res, 200, t)
        // 非投影会话（未注册/重启后）→ 实时查 agent 兜底
        const live = tasks.getTaskStatus(decodeURIComponent(detail[1]))
        if (live.status !== 'unknown') return json(res, 200, live)
        return json(res, 404, { error: 'task not found' })
      }
      return json(res, 404, { error: 'not found' })
    },
  })

  // GET /api/chats/:sid —— 简单会话状态（前端 getChat）
  webServer.register({
    kind: 'prefix',
    path: '/api/chats',
    handler: (req, res) => {
      const pathname = (req.url ?? '').split('?')[0]
      const m = pathname.match(/^\/api\/chats\/([^/]+)$/)
      if (!m || req.method !== 'GET') return json(res, 404, { error: 'not found' })
      const t = getTask(decodeURIComponent(m[1]))
      if (!t) return json(res, 404, { error: 'chat not live' })
      return json(res, 200, t)
    },
  })

  console.log('[helmsman-api] 业务 API 已注册：/api/projects* /api/cards* /api/tasks/:sid /api/chats/:sid')
}

export default { name, inject, apply }
