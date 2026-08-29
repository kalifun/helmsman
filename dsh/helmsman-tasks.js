// [helmsman] 任务编排插件（引擎内）：agents.create/followup 驱动面。
// 提供内部服务 helmsmanTasks（供 helmsman-api 调用）：
//   createTask({cwd, brief, preset, project_id, card_id}) → {sid}
//   sendComment(sid, text) → {ok}
//   getTaskStatus(sid) → {sid, status, reply}
// HTTP 路由统一在 helmsman-api（避免 /api/tasks 路由冲突）。
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'helmsman-tasks'
export const inject = ['agents', 'sessions', 'agentPresets', 'helmsmanBoard']

export function apply(ctx) {
  const { agents, sessions } = ctx
  const board = ctx.get('helmsmanBoard')

  ctx.provide('helmsmanTasks', {
    /** 建任务：引擎内 agents.create + 首条指令。返回 {sid}。 */
    async createTask({ cwd, brief, preset, project_id, card_id }) {
      const sid = SessionId(`task-${randomUUID().slice(0, 12)}`)
      // 先注册投影，再创建 agent：session/event 在 create 后立刻开始，注册必须先行
      if (board && (project_id || card_id)) {
        const pid = project_id ?? 'default'
        if (card_id) {
          const card = board.projection.projects?.[pid]?.cards?.[card_id]
          if (!card) throw new Error(`card '${card_id}' not in project '${pid}'`)
        }
        board.registerSession(sid, pid, card_id ?? '')
      }
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
      console.log(`[helmsman-tasks] created ${sid} cwd=${cwd} project=${project_id ?? '-'} card=${card_id ?? '-'}`)
      return { sid }
    },

    /** 评论 = 控制通道：followup 驱动 agent。 */
    sendComment(sid, text) {
      const agent = agents.get(SessionId(sid))
      if (!agent) throw new Error(`task ${sid} not live`)
      agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }))
      return { ok: true }
    },

    /** 任务状态：agent live 则实时读 session log；否则查投影。 */
    getTaskStatus(sid) {
      const agent = agents.get(SessionId(sid))
      if (agent) {
        return {
          sid: agent.id,
          status: agent.status,
          reply: extractAssistantText(agent.session.events),
        }
      }
      // 非 live（如引擎重启后）→ 查投影
      const pid = board?.projection?.sessionProject?.[sid]
      if (!pid) return { sid, status: 'unknown', reply: '' }
      const cardId = board.projection.sessionCard?.[sid]
      const proj = board.projection.projects?.[pid]
      const t = cardId ? proj?.cards?.[cardId]?.executions?.[sid] : proj?.chats?.[sid]
      return { sid, status: t?.status ?? 'unknown', reply: extractTaskReply(t) }
    },
  })

  console.log('[helmsman-tasks] 编排服务已提供：helmsmanTasks')
}

/** 从 session log 抽最后一条 assistant 文本。 */
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
  return text.trim()
}

/** 从投影 TaskState 抽最后一条 Text 活动。 */
function extractTaskReply(t) {
  if (!t) return ''
  const texts = []
  for (let i = t.activities.length - 1; i >= 0; i--) {
    const a = t.activities[i]
    if ('Text' in a) texts.unshift(a.Text.text)
    if (texts.length >= 3) break
  }
  return texts.join('\n')
}

export default { name, inject, apply }
