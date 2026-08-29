// [helmsman] D3-2 编排迁入：引擎进程内任务编排（替代 engine.ts + acp-client.ts 的 ACP 驱动面）。
// 验证：HTTP 网关 + 引擎内 agents.create/followup + session log 投影，三层闭环。
// 接口（最小闭环，前端全兼容留到 D3-4 之后）：
//   POST /api/tasks              {cwd, brief} → {session_id}
//   POST /api/tasks/:sid/comments {text}      → {ok:true}
//   GET  /api/tasks/:sid          → {sid, status, reply}
// 引擎进程内直接驱动，零 ACP 协议。
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'helmsman-tasks'
export const inject = ['webServer', 'agents', 'sessions', 'agentPresets']

export function apply(ctx) {
  const { webServer, agents, sessions } = ctx
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

  // 单个 prefix 路由统一分发 /api/tasks*（exact+prefix 同表重复会 throw，只能一个）
  webServer.register({
    kind: 'prefix',
    path: '/api/tasks',
    handler: async (req, res) => {
      const pathname = (req.url ?? '').split('?')[0]
      // POST /api/tasks —— 建任务
      if (pathname === '/api/tasks' && req.method === 'POST') {
        try {
          const { cwd, brief, preset } = await readBody(req)
          if (!cwd || !brief) return json(res, 400, { error: 'cwd and brief required' })
          const sid = SessionId(`task-${randomUUID().slice(0, 12)}`)
          const { agent } = await agents.create({
            sessionId: sid,
            meta: { cwd },
            agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
            // 任务级装配：preset 挂载（patch 3 的原生替代）+ model selection 接点
            setup: async (agentCtx) => {
              if (preset) {
                const presets = ctx.get('agentPresets')
                if (presets) await presets.mount(agentCtx, preset)
              }
            },
          })
          agent.followup(createUserMessage({
            content: [{ type: 'text', text: brief }],
            source: { kind: 'user' },
          }))
          console.log(`[helmsman-tasks] created ${sid} cwd=${cwd}`)
          return json(res, 201, { session_id: sid })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
      }

      // POST /api/tasks/:sid/comments —— 评论 = 控制通道
      const comment = pathname.match(/^\/api\/tasks\/([^/]+)\/comments$/)
      if (comment && req.method === 'POST') {
        const agent = agents.get(SessionId(comment[1]))
        if (!agent) return json(res, 404, { error: `task ${comment[1]} not live` })
        try {
          const { text } = await readBody(req)
          if (!text) return json(res, 400, { error: 'text required' })
          agent.followup(createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
          }))
          return json(res, 200, { ok: true })
        } catch (e) {
          return json(res, 500, { error: e?.message ?? String(e) })
        }
      }

      // GET /api/tasks/:sid —— 任务状态
      const detail = pathname.match(/^\/api\/tasks\/([^/]+)$/)
      if (detail && req.method === 'GET') {
        const agent = agents.get(SessionId(detail[1]))
        if (!agent) return json(res, 404, { error: `task ${detail[1]} not live` })
        return json(res, 200, {
          sid: agent.id,
          status: agent.status,
          reply: extractAssistantText(agent.session.events),
        })
      }

      return json(res, 404, { error: 'not found' })
    },
  })

  console.log('[helmsman-tasks] 编排路由已注册：/api/tasks*')
}

/** 从 session log 抽最后一条 assistant 文本（D3-3 换正式投影）。 */
function extractAssistantText(events) {
  let text = ''
  for (const ev of events) {
    if (ev.type !== 'assistant/message') continue
    const msg = ev.message ?? ev.data?.message ?? {}
    text = (msg.content ?? [])
      .filter((b) => b?.type === 'text')
      .map((b) => b.text)
      .join('')
  }
  return text
}

export default { name, inject, apply }
