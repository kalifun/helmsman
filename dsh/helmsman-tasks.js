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
export const inject = ['agents', 'sessions', 'agentPresets', 'helmsmanBoard', 'helmsmanStorage', 'helmsmanWorktree']

export function apply(ctx) {
  const { agents, sessions } = ctx
  const board = ctx.get('helmsmanBoard')
  const storage = ctx.get('helmsmanStorage')?.storage
  const worktree = ctx.get('helmsmanWorktree')

  ctx.provide('helmsmanTasks', {
    /** 建任务：引擎内 agents.create + 首条指令（sendBrief=false 则不发送，等后续输入）。返回 {sid, isolated}。 */
    async createTask({ cwd, brief, preset, project_id, card_id, sendBrief = true }) {
      const sid = SessionId(`task-${randomUUID().slice(0, 12)}`)
      const pid = project_id ?? 'default'
      // 任务级隔离：git 仓库 → worktree（agent 在隔离区跑，不写主工作区）；非 git/失败回退项目目录
      let runCwd = cwd
      let worktreeInfo = null
      let isolated = false
      if (worktree && card_id) {
        const wt = worktree.prepare(cwd, card_id, sid.slice(0, 8))
        if (wt) {
          runCwd = wt.path
          worktreeInfo = wt
        } else {
          isolated = true // M5：隔离区不可用 → 可见标记（前端提示"共享目录运行"）
        }
      }
      // 先注册投影，再创建 agent：session/event 在 create 后立刻开始，注册必须先行
      if (board && (project_id || card_id)) {
        if (card_id) {
          const card = board.projection.projects?.[pid]?.cards?.[card_id]
          if (!card) {
            if (worktreeInfo) worktree.discard(cwd, worktreeInfo)
            throw new Error(`card '${card_id}' not in project '${pid}'`)
          }
        }
        board.registerSession(sid, pid, card_id ?? '')
        // 执行快照落盘（重启后 session→卡 映射恢复的权威来源）
        if (storage && card_id) {
          const created = Date.now()
          storage.upsertExecution({
            id: sid, card_id, status: 'Pending', preset_json: '{}', deps_json: '[]',
            forked_from: null, started_at: null, finished_at: null, created_at: created,
          })
        }
        // 执行的工作区信息写入投影（前端展示隔离状态）
        const t = board.projection.projects?.[pid]?.cards?.[card_id]?.executions?.[sid]
        if (t) {
          t.worktree = worktreeInfo
          t.isolated = isolated
        }
      }
      const { agent } = await agents.create({
        sessionId: sid,
        meta: { cwd: runCwd },
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        // 任务级装配：preset 挂载（patch 3 的原生替代）+ model selection 接点
        setup: async (agentCtx) => {
          if (preset) {
            const presets = ctx.get('agentPresets')
            if (presets) await presets.mount(agentCtx, preset)
          }
        },
      })
      if (sendBrief && brief) {
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: brief }],
          source: { kind: 'user' },
        }))
      }
      console.log(`[helmsman-tasks] created ${sid} cwd=${runCwd} project=${pid ?? '-'} card=${card_id ?? '-'}${isolated ? ' (ISOLATION FAILED)' : ''}${sendBrief ? '' : ' (waiting input)'}`)
      return { sid, isolated, worktree: worktreeInfo }
    },

    /** 取消：引擎内 agent.cancel（替代 v1 的 ACP session/cancel）。 */
    cancelTask(sid) {
      const agent = agents.get(SessionId(sid))
      if (!agent) return false
      agent.cancel('user-cancelled')
      return true
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
