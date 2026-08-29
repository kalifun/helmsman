// [helmsman] 观察投影插件：session/event 实时事件流 → 看板投影（投影持有者）。
// 持有 Projection（helmsman-projection 纯函数），监听引擎 session/event 折叠。
// 提供内部服务：registerSession / getProjection（供 tasks/api 插件使用，经 ctx.provide）。
// 替代 v1 的 tail.ts（轮询 JSONL）+ recovery.ts（启动重放）+ index.ts 的投影持有。
export const name = 'helmsman-board'
export const inject = ['sessions', 'webServer']

import { WebSocketServer } from 'ws'
import {
  newProjection,
  ensureProject,
  ensureCard,
  registerSession,
  foldSession,
  foldTask,
  removeProject,
} from './helmsman-projection.js'

export function apply(ctx) {
  const { webServer } = ctx
  const proj = newProjection()

  // 实时折叠：session/event → foldSession（与 v1 tailer → foldTask 等价，但实时、无轮询）
  ctx.on('session/event', (session, event) => {
    if (!session?.id || !event) return
    // 会话已注册（sessionProject 有映射）才 fold；未注册的会话（如 distill 内部会话）忽略
    if (proj.sessionProject[session.id] !== undefined) {
      foldSession(proj, session.id, event)
    }
  })

  // 提供给其他插件的内部服务（helmsman-api / helmsman-tasks 经 ctx.get('helmsmanBoard') 使用）
  ctx.provide('helmsmanBoard', {
    get projection() { return proj },
    ensureProject: (id, name, path) => ensureProject(proj, id, name, path),
    ensureCard: (projectId, meta) => ensureCard(proj, projectId, meta),
    registerSession: (sessionId, projectId, cardId) => registerSession(proj, sessionId, projectId, cardId),
    fold: (sessionId, ev) => foldSession(proj, sessionId, ev),
    foldTask: (t, ev) => foldTask(t, ev),
    removeProject: (projectId) => removeProject(proj, projectId),
    sessions: () => proj.sessionProject,
  })

  // ---------- /api/events：实时事件推送（WS + SSE）→ 前端投影 store ----------
  // 前端期望 {type, seq, time, data}（session/event 原生形状）。WS 优先，SSE 兜底。
  // WS 用官方同款 ws 库（WebSocketServer noServer + handleUpgrade），不手写帧。
  const wss = new WebSocketServer({ noServer: true })
  const sseClients = new Set() // ServerResponse 集合（SSE 流）

  // 转发：session/event → 所有 WS/SSE 客户端（附加 session id 供前端路由）
  const forwardEvent = (session, event) => {
    const frame = { ...event, id: session?.id }
    const data = JSON.stringify(frame)
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        try { client.send(data) } catch { /* 忽略坏连接 */ }
      }
    }
    for (const res of sseClients) {
      try { res.write(`data: ${data}\n\n`) } catch { sseClients.delete(res) }
    }
  }

  // WS 升级：/api/events（官方模式：mux.handleUpgrade）
  webServer.registerUpgrade({
    path: '/api/events',
    handler: (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req)
      })
    },
  })

  // SSE 兜底：GET /api/events
  webServer.register({
    kind: 'exact',
    path: '/api/events',
    handler: (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405); return res.end()
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      sseClients.add(res)
      req.on('close', () => sseClients.delete(res))
    },
  })

  // 观察统计路由（D3-3 遗留，保留作探活）
  webServer.register({
    kind: 'exact',
    path: '/api/board/stats',
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        projects: Object.keys(proj.projects).length,
        sessions: Object.keys(proj.sessionProject).length,
        cards: Object.values(proj.projects).reduce((n, p) => n + Object.keys(p.cards).length, 0),
      }))
    },
  })

  // 在 session/event 监听里转发（与 fold 同源）
  ctx.on('session/event', (session, event) => {
    if (!session?.id || !event) return
    forwardEvent(session, event)
  })

  console.log('[helmsman-board] 投影持有者就绪，session/event 实时折叠中')
}

export default { name, inject, apply }
