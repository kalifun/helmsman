// [helmsman] 会话内切模型插件（引擎生态内形态，非 ACP 补丁）。
// 原理：dsh-agent 官方 installModelSelection(agentCtx, selection) —— 把可变 selection
// 挂到 agent 的请求路由（agent/request + system-prompt/assemble waterfall），
// selection.current 变化即下一轮生效。与官方 web / dsh-tui 的切模型机制一致。
// 本插件：agent/inbox/claimed（agent 收到消息，即将开始请求）时，从共享文件读该
// 会话选中模型 → 更新该 agent 的 selection。共享文件由 Helmsman server 写入。
import { readFileSync } from 'node:fs'
import { installModelSelection } from '@deepseek-ai/dsh-agent'

const MODEL_FILE = process.env.HELMSMAN_MODEL_FILE ?? '.helmsman/model-selection.json'
const DEFAULT_PROVIDER = 'deepseek-official'

/** 读共享文件：{ [sessionId]: model }（损坏容错）。 */
function readSelection() {
  try {
    const parsed = JSON.parse(readFileSync(MODEL_FILE, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export const name = 'helmsman-model-select'
export const inject = ['agents']

export function apply(ctx) {
  // 已安装的 selection 表：agent id → { disposer, selection }（每次收到消息刷新 current）
  const installed = new Map()

  ctx.on('agent/inbox/claimed', ({ agent }) => {
    if (!agent?.session?.id) return
    const sid = agent.session.id
    // 首次：安装模型选择（挂 agent 作用域 waterfall）
    if (!installed.has(agent.id)) {
      const selection = { current: undefined, assembled: undefined }
      const dispose = installModelSelection(agent.ctx, selection)
      installed.set(agent.id, { selection, dispose })
      // agent 销毁时清理
      agent.ctx.on('agent/disposed', () => {
        try { dispose() } catch { /* 幂等 */ }
        installed.delete(agent.id)
      })
    }
    // 刷新当前选中模型（共享文件）
    const selection = readSelection()
    const model = selection[sid]
    const entry = installed.get(agent.id)
    if (entry && typeof model === 'string' && model) {
      entry.selection.current = { provider: DEFAULT_PROVIDER, model }
    } else if (entry) {
      entry.selection.current = undefined // 未选中 → 回落引擎默认
    }
  })
}

export default { name, inject, apply }
