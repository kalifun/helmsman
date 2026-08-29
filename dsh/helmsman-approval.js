// [helmsman] D3-4 审批通道引擎内化：引擎插件 answerer 替代 patch 1（ACP requestPermission 桥接）。
// 原理：ctx.approval.request → 'approval/request' waterfall（scope=agent）。
// 本插件作为 answerer：把请求入队 → 返回挂起 promise（等 HTTP 批复）→ 兑现 outcome。
// 接口：
//   GET  /api/approvals/pending              → [{id, sid, tool_name, reason, at}]
//   POST /api/approvals/:id  {decision}      → {ok:true}（decision: 'allow'|'reject'）
// 超时/进程退出 → fail-closed（返回 'unavailable'，与引擎缺 answerer 语义一致）。
export const name = 'helmsman-approval'
export const inject = ['webServer', 'approval']

export function apply(ctx) {
  const { webServer } = ctx
  const pending = new Map() // id → { req, resolve, timer, at }

  // 唯一 answerer：入队并挂起，等 HTTP 批复
  ctx.on('approval/request', (req, next) => {
    const id = `ap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    return new Promise((resolve) => {
      const at = Date.now()
      const timer = setTimeout(() => {
        // 超时（60s）→ fail-closed；resolve 幂等（用户可能同时批复）
        pending.delete(id)
        resolve('unavailable')
      }, 60_000)
      pending.set(id, { req, resolve, timer, at })
      console.log(`[helmsman-approval] pending ${id} tool=${req.toolName} reason=${req.reason ?? '-'}`)
    })
  })

  // GET /api/approvals/pending —— 待批队列
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

  // POST /api/approvals/:id —— 用户批复（prefix 统一分发）
  webServer.register({
    kind: 'prefix',
    path: '/api/approvals',
    handler: (req, res) => {
      const pathname = (req.url ?? '').split('?')[0]
      const m = pathname.match(/^\/api\/approvals\/([^/]+)$/)
      if (!m) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"not found"}') }
      if (req.method !== 'POST') { res.writeHead(405); return res.end() }
      let buf = ''
      req.on('data', (c) => { buf += c })
      req.on('end', () => {
        try {
          const body = JSON.parse(buf || '{}')
          const entry = pending.get(m[1])
          if (!entry) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"unknown id"}') }
          clearTimeout(entry.timer)
          pending.delete(m[1])
          const decision = body.decision === 'reject' ? 'rejected' : 'allowed-once'
          entry.resolve(decision)
          console.log(`[helmsman-approval] decided ${m[1]} → ${decision}`)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, decision }))
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: e?.message ?? String(e) }))
        }
      })
    },
  })

  console.log('[helmsman-approval] 审批 answerer 已挂载，路由：/api/approvals*')
}

export default { name, inject, apply }
