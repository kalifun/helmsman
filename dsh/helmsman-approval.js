// [helmsman] D3-4 审批通道引擎内化：引擎插件 answerer 替代 patch 1（ACP requestPermission 桥接）。
// 原理：ctx.approval.request → 'approval/request' waterfall（scope=agent）。
// 本插件作为 answerer：把请求入队 → 返回挂起 promise（等 HTTP 批复）→ 兑现 outcome。
// B1 扩展：兼容前端契约（/api/approvals?project=、decideApproval(id, outcome, comment, remember)）。
// 接口：
//   GET  /api/approvals/pending            → [{id, sid, tool_name, reason, at}]（内部探活）
//   GET  /api/approvals?project=           → [{id, sid, kind, reason, status, ...}]（前端契约）
//   GET  /api/approvals/suspended?project= → 挂起列表
//   POST /api/approvals/:id                {outcome:'approved'|'rejected', comment, remember} → {ok:true}
//   POST /api/approvals/:id/resume         → {ok:true}
//   POST /api/projects/:pid/approvals/resume-all → {ok:true}
// 超时/进程退出 → fail-closed（返回 'unavailable'，与引擎缺 answerer 语义一致）。
export const name = 'helmsman-approval'
export const inject = ['webServer', 'approval', 'helmsmanStorage']

export function apply(ctx) {
  const { webServer } = ctx
  const pending = new Map() // id → { req, resolve, timer, at, project_id }
  const resolved = [] // 已决策记录（最近 50 条，供列表回显）
  let seq = 0

  // 唯一 answerer：入队并挂起，等 HTTP 批复
  ctx.on('approval/request', (req, next) => {
    seq += 1
    const id = seq
    return new Promise((resolve) => {
      const at = Date.now()
      // 从 agent 的 cwd 推断项目归属（sessionProject 映射由 board 维护，这里简化：用 agent.id 前缀）
      const project_id = req.agent?.session?.header?.cwd ? 'p-' + at.toString(36) : undefined
      const timer = setTimeout(() => {
        pending.delete(id)
        resolved.unshift({ id, project_id, sid: req.agent?.id, tool_name: req.toolName, reason: req.reason, status: 'unavailable', at })
        if (resolved.length > 50) resolved.pop()
        resolve('unavailable')
      }, 300_000) // 5 分钟超时（比 v1 宽松）
      pending.set(id, { req, resolve, timer, at, project_id })
      console.log(`[helmsman-approval] pending ${id} tool=${req.toolName} reason=${req.reason ?? '-'}`)
    })
  })

  // GET /api/approvals —— 前端契约列表（?project= 过滤）
  webServer.register({
    kind: 'exact',
    path: '/api/approvals',
    handler: (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost')
      const pid = url.searchParams.get('project')
      const list = [...pending.entries()].map(([id, p]) => ({
        id,
        sid: p.req.agent?.id,
        tool_name: p.req.toolName,
        call_id: p.req.callId ?? undefined,
        reason: p.req.reason,
        kind: 'permission',
        status: 'pending',
        project_id: p.project_id,
        created_at: p.at,
      })).filter((a) => !pid || a.project_id === pid)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(list))
    },
  })

  // GET /api/approvals/suspended —— 挂起列表（B1：已决策的 rejected 记录简化呈现）
  webServer.register({
    kind: 'exact',
    path: '/api/approvals/suspended',
    handler: (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost')
      const pid = url.searchParams.get('project')
      const list = resolved
        .filter((a) => !pid || a.project_id === pid)
        .map((a) => ({ ...a, status: 'suspended' }))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(list))
    },
  })

  // GET /api/approvals/pending —— 内部探活（保留）
  webServer.register({
    kind: 'exact',
    path: '/api/approvals/pending',
    handler: (_req, res) => {
      const list = [...pending.entries()].map(([id, p]) => ({
        id,
        sid: p.req.agent?.id,
        tool_name: p.req.toolName,
        call_id: p.req.callId ?? undefined,
        reason: p.req.reason,
        at: p.at,
      }))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(list))
    },
  })

  // POST /api/approvals/:id 与 /api/approvals/:id/resume —— 批复/恢复（prefix 统一分发）
  webServer.register({
    kind: 'prefix',
    path: '/api/approvals',
    handler: (req, res) => {
      const pathname = (req.url ?? '').split('?')[0]
      const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
      if (req.method !== 'POST') return json(405, { error: 'method not allowed' })
      const resume = pathname.match(/^\/api\/approvals\/([^/]+)\/resume$/)
      if (resume) {
        // B1 简化：resume 无挂起语义（v1 是 Waiting 超时挂起恢复）；返回 ok
        return json(200, { ok: true })
      }
      const m = pathname.match(/^\/api\/approvals\/([^/]+)$/)
      if (!m) return json(404, { error: 'not found' })
      let buf = ''
      req.on('data', (c) => { buf += c })
      req.on('end', () => {
        try {
          const body = JSON.parse(buf || '{}')
          const id = Number(m[1])
          const entry = pending.get(id)
          if (!entry) return json(404, { error: 'unknown id' })
          clearTimeout(entry.timer)
          pending.delete(id)
          // 前端 outcome: 'approved'|'rejected' → 引擎 ApprovalOutcome
          const outcome = body.outcome === 'rejected' ? 'rejected' : 'allowed-once'
          entry.resolve(outcome)
          resolved.unshift({
            id, project_id: entry.project_id, sid: entry.req.agent?.id,
            tool_name: entry.req.toolName, reason: entry.req.reason,
            status: outcome === 'rejected' ? 'rejected' : 'approved', at: entry.at,
          })
          if (resolved.length > 50) resolved.pop()
          // 评论（可选）：批复时附带说明 → 送达 agent
          if (typeof body.comment === 'string' && body.comment.trim() && entry.req.agent) {
            try {
              entry.req.agent.followup?.({ role: 'user', content: [{ type: 'text', text: body.comment }], source: { kind: 'user' } })
            } catch { /* 送达失败不阻断批复 */ }
          }
          console.log(`[helmsman-approval] decided ${id} → ${outcome}`)
          json(200, { ok: true, decision: outcome })
        } catch (e) {
          json(500, { error: e?.message ?? String(e) })
        }
      })
    },
  })

  // POST /api/projects/:pid/approvals/resume-all 由 helmsman-api 的 /api/projects prefix 处理
  // （避免跨插件 prefix 路由冲突）。注：B1 简化 —— 无挂起恢复语义，返回 ok。

  // ---------- 策略沉淀（P1 O6：SQLite 持久化） ----------
  const storage = ctx.get('helmsmanStorage')?.storage
  const rememberPolicy = (project_id, tool_name, outcome) => {
    if (storage) return storage.learnPolicy(project_id, 'tool', tool_name, outcome)
    return null
  }

  // GET /api/policies?project= —— 策略列表
  webServer.register({
    kind: 'exact',
    path: '/api/policies',
    handler: (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost')
      const pid = url.searchParams.get('project')
      const list = storage ? storage.listPolicies(pid ?? '') : []
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(list))
    },
  })

  // DELETE /api/policies/:id —— 删除策略
  webServer.register({
    kind: 'prefix',
    path: '/api/policies',
    handler: (req, res) => {
      const pathname = (req.url ?? '').split('?')[0]
      const m = pathname.match(/^\/api\/policies\/(\d+)$/)
      if (!m || req.method !== 'DELETE') {
        res.writeHead(404, { 'content-type': 'application/json' })
        return res.end('{"error":"not found"}')
      }
      const ok = storage ? storage.deletePolicy(Number(m[1])) : false
      res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' })
      res.end(JSON.stringify(ok ? { ok: true } : { error: 'not found' }))
    },
  })

  console.log('[helmsman-approval] 审批 answerer 已挂载，路由：/api/approvals*（前端契约兼容）')
}

export default { name, inject, apply }
