// [helmsman] D3-3 观察迁入（轻量验证）：引擎实时事件流 vs JSONL tail。
// 验证前提：ctx.on('session/event') 能实时收到与 JSONL 持久化一致的事件，
// 且字段（type/seq/time/data）与 server-ts projection.foldTask 期望完全兼容。
// 说明：这版只验证事件流可达性 + 字段形状，不搬投影逻辑（D3-3 完整版再搬）。
export const name = 'helmsman-board'
export const inject = ['sessions']

export function apply(ctx) {
  let count = 0
  const seen = new Map() // 事件类型 → 次数

  ctx.on('session/event', (session, event) => {
    count += 1
    const ty = event?.type ?? '?'
    seen.set(ty, (seen.get(ty) ?? 0) + 1)
    // 打印前几个事件 + 关键事件（assistant/message / turn/end），验证字段形状
    if (count <= 5 || ty === 'assistant/message' || ty === 'turn/end') {
      console.log(`[helmsman-board] sid=${session?.id} seq=${event?.seq} type=${ty} dataKeys=${Object.keys(event?.data ?? {}).join(',') || '-'}`)
    }
  })

  // 提供一个查询路由：事件流统计（验证路由层也能读到投影）
  ctx.get('webServer')?.register?.({
    kind: 'exact',
    path: '/api/board/stats',
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ total: count, byType: Object.fromEntries(seen) }))
    },
  })
}

export default { name, inject, apply }
