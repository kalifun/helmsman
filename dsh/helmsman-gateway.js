// [helmsman] D3-1 网关先行：引擎进程内挂 HTTP 服务（复用官方 dsh-host-webserver）。
// 验证前提：引擎进程能当服务器 —— 后续 helmsman-api 的全部 /api 路由都挂在这。
// 本插件只验证传输层（register 路由 + 响应），不含任何业务逻辑。
export const name = 'helmsman-gateway'
export const inject = ['webServer']

export function apply(ctx) {
  const { webServer } = ctx

  // GET /api/health —— 探活
  webServer.register({
    kind: 'exact',
    path: '/api/health',
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        engine: 'dsh',
        plugin: name,
        port: webServer.port,
      }))
    },
  })

  // GET /api/ping —— 第二个验证路由（证明多路由注册）
  webServer.register({
    kind: 'exact',
    path: '/api/ping',
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ pong: true, t: Date.now() }))
    },
  })

  console.log(`[helmsman-gateway] HTTP 路由已注册：/api/health /api/ping (port=${webServer.port})`)
}

export default { name, inject, apply }
