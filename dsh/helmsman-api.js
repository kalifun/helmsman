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
import { execSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'helmsman-api'
export const inject = ['webServer', 'helmsmanBoard', 'helmsmanTasks', 'helmsmanStorage', 'sessionTitle', 'sessions', 'agents']

export function apply(ctx) {
  const { webServer } = ctx
  const board = ctx.get('helmsmanBoard')
  const tasks = ctx.get('helmsmanTasks')
  const storage = ctx.get('helmsmanStorage')?.storage
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
  // 项目 Profile（P0 §2.6 三轴组合；SQLite 持久化）
  const ensureBuiltins = (pid) => {
    if (storage) storage.seedProfiles(pid)
    return storage ? storage.listProfiles(pid) : []
  }
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
            if (storage) storage.upsertProject(pid, body.name, body.path, '{}')
            json(res, 201, { id: pid })
          } catch (e) {
            json(res, 500, { error: e?.message ?? String(e) })
          }
        })()
      }
      return json(res, 405, { error: 'method not allowed' })
    },
  })

  // /api/projects/:pid —— 项目详情/删除
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
      if (detail && req.method === 'DELETE') {
        const pid = decodeURIComponent(detail[1])
        const p = getProject(pid)
        if (!p) return json(res, 404, { error: 'project not found' })
        try {
          const body = await readBody(req)
          const mode = body.mode === 'purge' ? 'purge' : 'archive'
          board.removeProject(pid)
          if (storage) {
            if (mode === 'purge') {
              storage.purgeProject(pid)
              storage.markDeleted(pid)
            } else {
              storage.archiveProject(pid)
            }
          }
          console.log(`[helmsman-api] project ${pid} removed (${mode}) path=${p.path}`)
          return json(res, 200, { ok: true, mode, sessions: 0 })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
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
          const created = Date.now()
          board.ensureCard(p.id, {
            id: cardId,
            title: body.title ?? '(无题)',
            description: body.description ?? '',
            kind: body.kind ?? 'task',
            milestone: body.milestone ?? null,
            criteria: body.criteria ?? null,
            deps: body.deps ?? [],
            created_at: created,
          })
          if (storage) storage.upsertCard({
            id: cardId, project_id: p.id, title: body.title ?? '(无题)',
            description: body.description ?? '', kind: body.kind ?? 'task',
            milestone: body.milestone ?? null, criteria: body.criteria ?? null,
            deps: body.deps ?? [], budget: body.budget ?? null, created_at: created,
          })
          return json(res, 201, { card_id: cardId })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
      }
      // GET /api/projects/:pid/chats/archived —— 归档会话列表（含恢复入口数据）
      const chatsArch = pathname.match(/^\/api\/projects\/([^/]+)\/chats\/archived$/)
      if (chatsArch && req.method === 'GET') {
        const p = getProject(decodeURIComponent(chatsArch[1]))
        if (!p) return json(res, 404, { error: 'project not found' })
        const list = Object.values(p.chats)
          .filter((t) => t.archived)
          .map((t) => ({
            session_id: t.id,
            title: t.title ?? null,
            status: t.status,
            started_at: t.started_at ?? null,
            finished_at: t.finished_at ?? null,
          }))
        return json(res, 200, list)
      }
      // GET/POST /api/projects/:pid/chats —— 简单会话列表/新建
      const chats = pathname.match(/^\/api\/projects\/([^/]+)\/chats$/)
      if (chats && req.method === 'GET') {
        const p = getProject(decodeURIComponent(chats[1]))
        if (!p) return json(res, 404, { error: 'project not found' })
        // 列表只显示未归档会话（archived 标记由归档端点设置）
        const list = Object.values(p.chats)
          .filter((t) => !t.archived)
          .map((t) => ({
            session_id: t.id,
            title: t.title ?? null,
            status: t.status,
            started_at: t.started_at ?? null,
            finished_at: t.finished_at ?? null,
          }))
        return json(res, 200, list)
      }
      if (chats && req.method === 'POST') {
        const p = getProject(decodeURIComponent(chats[1]))
        if (!p) return json(res, 404, { error: 'project not found' })
        try {
          // 简单会话：建 agent 但无首条指令（sendBrief=false，等用户第一次输入）
          const { sid } = await tasks.createTask({
            cwd: p.path,
            brief: undefined,
            sendBrief: false,
            project_id: p.id,
            card_id: undefined,
          })
          return json(res, 201, { session_id: sid })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
      }
      // POST /api/projects/:pid/approvals/resume-all —— 批量恢复（B1 简化 ok）
      const resumeAll = pathname.match(/^\/api\/projects\/([^/]+)\/approvals\/resume-all$/)
      if (resumeAll && req.method === 'POST') {
        return json(res, 200, { ok: true })
      }
      // /api/projects/:pid/presets* —— 项目 Profile 管理（P0 §2.6 三轴组合；B1 内存存储）
      const presetsM = pathname.match(/^\/api\/projects\/([^/]+)\/presets(?:\/([^/]+))?(?:\/(default))?$/)
      if (presetsM) {
        const pid2 = decodeURIComponent(presetsM[1])
        const id2 = presetsM[2] ? decodeURIComponent(presetsM[2]) : undefined
        const isDefault = presetsM[3] === 'default'
        const p2 = getProject(pid2)
        if (!p2) return json(res, 404, { error: 'project not found' })
        const profiles = ensureBuiltins(pid2)
        if (!id2 && req.method === 'GET') return json(res, 200, profiles)
        if (!id2 && req.method === 'POST') {
          try {
            const body = await readBody(req)
            const valid = (v, arr) => arr.includes(v)
            if (!valid(body.mode, ['normal', 'plan', 'goal']) || !valid(body.setting, ['light', 'balanced', 'delivery'])
              || !valid(body.approval, ['ask', 'auto', 'yolo']) || !valid(body.sandbox, ['read-only', 'workspace-write', 'danger-full-access'])) {
              return json(res, 400, { error: 'invalid profile axes' })
            }
            const prof = {
              id: `pf-${Date.now().toString(36)}`,
              project_id: pid2,
              name: typeof body.name === 'string' ? body.name : '(未命名)',
              is_builtin: false,
              mode: body.mode, setting: body.setting, approval: body.approval, sandbox: body.sandbox,
              is_default: false,
            }
            if (storage) storage.upsertProfile(pid2, prof)
            return json(res, 201, prof)
          } catch (e) {
            return json(res, 500, { error: e?.message ?? String(e) })
          }
        }
        if (id2 && isDefault && req.method === 'POST') {
          const target = profiles.find((p) => p.id === id2)
          if (!target) return json(res, 404, { error: 'profile not found' })
          if (storage) storage.setDefaultProfile(pid2, id2)
          return json(res, 200, { ok: true })
        }
        if (id2 && !isDefault && req.method === 'DELETE') {
          const target = profiles.find((p) => p.id === id2)
          if (!target) return json(res, 404, { error: 'profile not found' })
          if (target.is_builtin) return json(res, 400, { error: 'cannot delete builtin' })
          if (storage) storage.removeProfile(pid2, id2)
          return json(res, 200, { ok: true })
        }
        return json(res, 404, { error: 'not found' })
      }
      return json(res, 404, { error: 'not found' })
    },
  })

  // /api/cards/* —— 卡操作（详情/状态标记/新执行代次/校准）
  webServer.register({
    kind: 'prefix',
    path: '/api/cards',
    handler: async (req, res) => {
      const pathname = (req.url ?? '').split('?')[0]
      const findCard = (cardId) => {
        for (const p of Object.values(board.projection.projects)) {
          if (p.cards[cardId]) return { project: p, card: p.cards[cardId] }
        }
        return null
      }
      // GET /api/cards/:cardId —— 卡详情（全部执行代次）
      const detail = pathname.match(/^\/api\/cards\/([^/]+)$/)
      if (detail && req.method === 'GET') {
        const found = findCard(decodeURIComponent(detail[1]))
        if (!found) return json(res, 404, { error: 'card not found' })
        const { project, card } = found
        return json(res, 200, { ...card, project_id: project.id, execution_count: card.exec_order.length })
      }
      // POST /api/cards/:cardId/status —— 手动标记状态
      const status = pathname.match(/^\/api\/cards\/([^/]+)\/status$/)
      if (status && req.method === 'POST') {
        const found = findCard(decodeURIComponent(status[1]))
        if (!found) return json(res, 404, { error: 'card not found' })
        try {
          const body = await readBody(req)
          const s = body.status
          if (s !== 'Done' && s !== 'Failed' && s !== 'Pending' && s !== 'Running' && s !== 'Cancelled') {
            return json(res, 400, { error: 'status must be one of Done|Failed|Pending|Running|Cancelled' })
          }
          const order = found.card.exec_order.length ? found.card.exec_order : Object.keys(found.card.executions)
          const sid = order[order.length - 1]
          const t = sid ? found.card.executions[sid] : undefined
          if (!t) return json(res, 400, { error: 'card has no execution to mark' })
          t.status = s
          if (s === 'Done') t.finished_at = t.finished_at ?? Date.now()
          else if (s === 'Pending') t.finished_at = undefined
          return json(res, 200, { ok: true, status: s })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
      }
      // POST /api/cards/:cardId/executions —— 起新执行代次（fork）
      const exec = pathname.match(/^\/api\/cards\/([^/]+)\/executions$/)
      if (exec && req.method === 'POST') {
        const found = findCard(decodeURIComponent(exec[1]))
        if (!found) return json(res, 404, { error: 'card not found' })
        try {
          const body = await readBody(req)
          const { sid } = await tasks.createTask({
            cwd: found.project.path,
            brief: body.brief ?? `继续执行：${found.card.title}`,
            preset: body.preset,
            project_id: found.project.id,
            card_id: found.card.id,
          })
          return json(res, 201, { card_id: found.card.id, session_id: sid, forked_from: body.from_execution_id ?? null })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
      }
      // POST /api/cards/:cardId/calibrate —— 需求校准（新执行代次 + calib 标记）
      const calib = pathname.match(/^\/api\/cards\/([^/]+)\/calibrate$/)
      if (calib && req.method === 'POST') {
        const found = findCard(decodeURIComponent(calib[1]))
        if (!found) return json(res, 404, { error: 'card not found' })
        try {
          const { sid } = await tasks.createTask({
            cwd: found.project.path,
            brief: `请为卡「${found.card.title}」产出验收标准提案，完成后输出【验收标准完毕】`,
            preset: found.card.criteria ? undefined : undefined,
            project_id: found.project.id,
            card_id: found.card.id,
          })
          // 标记为校准会话（不算正常执行代次）
          const t = found.card.executions[sid]
          if (t) t.calib = true
          return json(res, 201, { card_id: found.card.id, session_id: sid, kind: 'calibrate' })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
      }
      return json(res, 404, { error: 'not found' })
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
      // POST /api/tasks/:sid/cancel —— 停止（引擎内 agent.cancel）
      const cancel = pathname.match(/^\/api\/tasks\/([^/]+)\/cancel$/)
      if (cancel && req.method === 'POST') {
        try {
          const ok = tasks.cancelTask(decodeURIComponent(cancel[1]))
          return json(res, 200, { ok })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
      }
      // POST /api/tasks/:sid/waiting —— 触发 Waiting{kind}（任务停在等待批复）
      const waiting = pathname.match(/^\/api\/tasks\/([^/]+)\/waiting$/)
      if (waiting && req.method === 'POST') {
        try {
          const body = await readBody(req)
          const t = getTask(decodeURIComponent(waiting[1]))
          if (!t) return json(res, 404, { error: 'task not found' })
          const kind = body.kind === 'plan' || body.kind === 'permission' || body.kind === 'acceptance'
            || body.kind === 'cost' || body.kind === 'calibrate' || body.kind === 'checkpoint' ? body.kind : 'permission'
          t.waiting = {
            kind,
            reason: typeof body.reason === 'string' ? body.reason : '',
            payload: typeof body.payload === 'object' && body.payload !== null ? body.payload : {},
          }
          return json(res, 200, { ok: true, kind })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
      }
      return json(res, 404, { error: 'not found' })
    },
  })

  // /api/chats/* —— 简单会话（状态/发消息/提升/沉淀）
  webServer.register({
    kind: 'prefix',
    path: '/api/chats',
    handler: async (req, res) => {
      const pathname = (req.url ?? '').split('?')[0]
      // GET /api/chats/:sid —— 会话状态（TaskState 形状）
      const m = pathname.match(/^\/api\/chats\/([^/]+)$/)
      if (m && req.method === 'GET') {
        const t = getTask(decodeURIComponent(m[1]))
        if (!t) return json(res, 404, { error: 'chat not live' })
        return json(res, 200, t)
      }
      // POST /api/chats/:sid —— 发消息（sendChat）
      if (m && req.method === 'POST') {
        try {
          const body = await readBody(req)
          if (!body.text) return json(res, 400, { error: 'text required' })
          tasks.sendComment(decodeURIComponent(m[1]), body.text)
          return json(res, 200, { ok: true })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
      }
      // POST /api/chats/:sid/fork —— 分叉会话（复制历史为新会话）
      const forkM = pathname.match(/^\/api\/chats\/([^/]+)\/fork$/)
      if (forkM && req.method === 'POST') {
        try {
          const srcSid = decodeURIComponent(forkM[1])
          const { sid: newSid } = await tasks.forkTask({
            sid: srcSid,
            project_id: board.projection.sessionProject?.[srcSid],
            card_id: board.projection.sessionCard?.[srcSid] || undefined,
          })
          return json(res, 201, { session_id: newSid, forked_from: srcSid })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
      }
      // POST /api/chats/:sid/archive —— 归档会话（移出列表；投影标记 archived）
      const archM = pathname.match(/^\/api\/chats\/([^/]+)\/archive$/)
      if (archM && req.method === 'POST') {
        const sid = decodeURIComponent(archM[1])
        const t = getTask(sid)
        if (!t) return json(res, 404, { error: 'chat not found' })
        t.archived = true
        return json(res, 200, { ok: true })
      }
      // POST /api/chats/:sid/restore —— 恢复归档会话（archived 标记清除）
      const restM = pathname.match(/^\/api\/chats\/([^/]+)\/restore$/)
      if (restM && req.method === 'POST') {
        const sid = decodeURIComponent(restM[1])
        const t = getTask(sid)
        if (!t) return json(res, 404, { error: 'chat not found' })
        t.archived = false
        return json(res, 200, { ok: true })
      }
      // POST /api/chats/:sid/title —— 用户改标题（引擎 sessionTitle.rename，钉住后自动生成停止）
      const titleM = pathname.match(/^\/api\/chats\/([^/]+)\/title$/)
      if (titleM && req.method === 'POST') {
        try {
          const body = await readBody(req)
          const title = typeof body.title === 'string' ? body.title.trim() : ''
          if (!title) return json(res, 400, { error: 'title required' })
          // 用 sessionTitle.rename（需要 live session；改名后钉住，自动生成停止）
          // live 会话：agent.session 是权威 live 实例；历史会话（重启后未 resume）：先 resume 再 rename
          const sid = decodeURIComponent(titleM[1])
          const session = ctx.get('sessionTitle')
          let agent = ctx.get('agents')?.get?.(sid)
          if (!agent?.session) {
            // 历史会话：resume 拿 live session（resume 后 title 写入 JSONL，重启重放保留）
            try {
              const resumed = await ctx.get('agents')?.resume?.({
                resumeSessionId: SessionId(sid),
                agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
              })
              agent = resumed?.agent
            } catch (e) {
              return json(res, 404, { error: `session not resumeable: ${e?.message ?? e}` })
            }
          }
          if (!agent?.session) return json(res, 404, { error: 'session not live' })
          const renamed = session.rename(agent.session, title)
          return json(res, 200, { ok: true, title: renamed.title })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
      }
      // POST /api/chats/:sid/promote —— 提升为卡（会话上下文进卡，建卡自动跑）
      const promote = pathname.match(/^\/api\/chats\/([^/]+)\/promote$/)
      if (promote && req.method === 'POST') {
        try {
          const sid = decodeURIComponent(promote[1])
          const t = getTask(sid)
          const pid = board.projection.sessionProject?.[sid]
          if (!t || !pid) return json(res, 404, { error: 'chat not found' })
          const project = getProject(pid)
          if (!project) return json(res, 404, { error: 'project not found' })
          const firstUser = t.comments.find((c) => c.who === 'user')?.text ?? ''
          const cardId = `c-${Date.now().toString(36)}`
          board.ensureCard(pid, {
            id: cardId,
            title: t.title ?? firstUser.slice(0, 40) ?? '从会话提升',
            description: firstUser,
            kind: 'task',
            milestone: null,
            criteria: null,
            deps: [],
            created_at: Date.now(),
          })
          return json(res, 201, { card_id: cardId, session_id: sid })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
      }
      // POST /api/chats/:sid/kb —— 沉淀到知识库（saveChatToKb）
      const toKb = pathname.match(/^\/api\/chats\/([^/]+)\/kb$/)
      if (toKb && req.method === 'POST') {
        try {
          const sid = decodeURIComponent(toKb[1])
          const t = getTask(sid)
          if (!t) return json(res, 404, { error: 'chat not found' })
          const text = (t.activities ?? []).filter((a) => 'Text' in a).map((a) => a.Text.text).join('\n').slice(-2000)
          return json(res, 200, { ok: true, note_chars: text.length, note: null })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
      }
      return json(res, 404, { error: 'not found' })
    },
  })

  // ---------- /api/presets —— 可用 agent 预设（读引擎 agentPresets 服务） ----------
  webServer.register({
    kind: 'exact',
    path: '/api/presets',
    handler: async (_req, res) => {
      try {
        const presets = ctx.get('agentPresets')
        const list = presets ? await presets.list() : []
        json(res, 200, list.map((p) => ({ id: p.id, name: p.id, description: p.id })))
      } catch (e) {
        json(res, 500, { error: e?.message ?? String(e) })
      }
    },
  })

  // ---------- /api/metrics —— 执行度量（从投影派生，B1 简化：无 SQLite 持久化） ----------
  webServer.register({
    kind: 'exact',
    path: '/api/metrics',
    handler: (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost')
      const pid = url.searchParams.get('project')
      const rows = []
      for (const [projectId, p] of Object.entries(board.projection.projects)) {
        if (pid && projectId !== pid) continue
        for (const card of Object.values(p.cards)) {
          for (const [sid, t] of Object.entries(card.executions)) {
            rows.push({
              id: rows.length + 1,
              project_id: projectId,
              task_id: sid,
              brief_snapshot: [],
              outcome: t.status,
              cited_entries: [],
              turns: t.turns,
              steps: t.steps,
              group_tag: undefined,
              verified: false,
              cost: 0,
              cache_hit: t.usage?.cacheReadTokens ?? 0,
              in_tokens: t.usage?.inputTokens ?? 0,
              cache_tokens: t.usage?.cacheReadTokens ?? 0,
              out_tokens: t.usage?.outputTokens ?? 0,
              reasoning_tokens: t.usage?.reasoningTokens ?? 0,
            })
          }
        }
      }
      return json(res, 200, rows)
    },
  })

  // ---------- /api/experiments/* —— 对照实验（B1 简化：建 A/B 对照卡，不持久化对比） ----------
  webServer.register({
    kind: 'prefix',
    path: '/api/experiments',
    handler: async (req, res) => {
      const pathname = (req.url ?? '').split('?')[0]
      // POST /api/experiments/run —— 跑一组任务（建卡自动执行）
      if (pathname === '/api/experiments/run' && req.method === 'POST') {
        try {
          const body = await readBody(req)
          const projectId = typeof body.project_id === 'string' ? body.project_id : undefined
          const p = projectId ? getProject(projectId) : undefined
          if (!p) return json(res, 404, { error: 'project not found' })
          if (!Array.isArray(body.tasks) || body.tasks.length === 0) return json(res, 400, { error: 'tasks required' })
          const brief = body.brief !== false
          const group = brief ? 'A' : 'B'
          const name = typeof body.name === 'string' && body.name ? body.name : brief ? 'A 带装配' : 'B 裸跑'
          const created = []
          for (const t of body.tasks) {
            const title = typeof t?.title === 'string' ? t.title.trim() : ''
            if (!title) continue
            const cardId = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
            board.ensureCard(p.id, {
              id: cardId,
              title,
              description: typeof t?.description === 'string' ? t.description : '',
              kind: 'task',
              milestone: null,
              criteria: typeof t?.acceptance === 'string' && t.acceptance.trim() ? t.acceptance.trim() : null,
              deps: [],
              created_at: Date.now(),
            })
            const { sid } = await tasks.createTask({
              cwd: p.path,
              brief: title,
              project_id: p.id,
              card_id: cardId,
            })
            created.push({ card_id: cardId, session_id: sid, title })
          }
          return json(res, 201, { group, name, created })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
      }
      // GET /api/experiments/compare?project= —— 对比（B1：从投影派生 A/B 概览）
      if (pathname === '/api/experiments/compare' && req.method === 'GET') {
        const url = new URL(req.url ?? '', 'http://localhost')
        const projectId = url.searchParams.get('project')
        const p = projectId ? getProject(projectId) : undefined
        if (!p) return json(res, 404, { error: 'project not found' })
        const all = []
        for (const card of Object.values(p.cards)) {
          for (const [sid, t] of Object.entries(card.executions)) {
            all.push({ task_id: sid, outcome: t.status, turns: t.turns, steps: t.steps, cost: 0 })
          }
        }
        return json(res, 200, { project_id: p.id, a: all, b: [] })
      }
      return json(res, 404, { error: 'not found' })
    },
  })

  // ---------- /api/fs/* —— 本地文件浏览（新建项目选目录） ----------
  webServer.register({
    kind: 'prefix',
    path: '/api/fs',
    handler: (req, res) => {
      const pathname = (req.url ?? '').split('?')[0]
      const url = new URL(req.url ?? '', 'http://localhost')
      // POST /api/fs/pick —— 系统选目录对话框（macOS）
      if (pathname === '/api/fs/pick' && req.method === 'POST') {
        try {
          const out = execSync('osascript -e \'POSIX path of (choose folder with prompt "选择项目目录")\'', {
            encoding: 'utf8',
            timeout: 60000,
          }).trim()
          return json(res, 200, out ? { cancelled: false, path: out } : { cancelled: true })
        } catch {
          return json(res, 200, { cancelled: true })
        }
      }
      // GET /api/fs/list?path= —— 目录浏览
      if (pathname === '/api/fs/list' && req.method === 'GET') {
        const home = homedir()
        const canon = resolve(url.searchParams.get('path') || home)
        const entries = []
        let dirEntries = []
        try {
          dirEntries = readdirSync(canon, { withFileTypes: true }).map((e) => ({
            name: e.name,
            isDir: e.isDirectory(),
            isSymlink: e.isSymbolicLink(),
          }))
        } catch { /* ignore */ }
        for (const e of dirEntries) {
          if (e.name.startsWith('.')) continue
          entries.push({ name: e.name, path: join(canon, e.name), is_dir: e.isDir, is_symlink: e.isSymlink })
        }
        entries.sort((a, b) => (b.is_dir ? 1 : 0) - (a.is_dir ? 1 : 0) || (a.name < b.name ? -1 : 1))
        return json(res, 200, { path: canon, parent: dirname(canon), entries })
      }
      // GET /api/fs/find?name=&max= —— 按名搜索（广度优先，限深限数）
      if (pathname === '/api/fs/find' && req.method === 'GET') {
        const name = url.searchParams.get('name') ?? ''
        if (!name) return json(res, 400, { error: 'empty name' })
        const max = Math.min(Math.max(Number(url.searchParams.get('max') ?? 5), 1), 20)
        const home = homedir()
        const found = []
        let visited = 0
        const queue = [[home, 0]]
        while (queue.length > 0 && found.length < max && visited < 30000) {
          const [dir, depth] = queue.shift()
          visited += 1
          let children = []
          try {
            children = readdirSync(dir, { withFileTypes: true }).map((e) => ({
              name: e.name, isDir: e.isDirectory(), isSymlink: e.isSymbolicLink(),
            }))
          } catch { continue }
          for (const c of children) {
            if (c.name.startsWith('.') || c.name === 'node_modules') continue
            if (c.name.includes(name)) {
              found.push({ name: c.name, path: join(dir, c.name) })
              if (found.length >= max) break
            }
            if (c.isDir && depth < 4) queue.push([join(dir, c.name), depth + 1])
          }
        }
        return json(res, 200, { found })
      }
      return json(res, 404, { error: 'not found' })
    },
  })

  console.log('[helmsman-api] 业务 API 已注册：/api/projects* /api/cards* /api/tasks* /api/chats* /api/fs*')
}

export default { name, inject, apply }
