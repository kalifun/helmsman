// [helmsman] 实验：引擎进程内直接编排 agent（零 ACP 补丁）。
// 验证链路：
//   1. ctx.agents.create({ sessionId, meta:{cwd}, agentOptions, setup }) —— 引擎内建任务会话
//   2. handle.agent.followup(createUserMessage(...)) —— 直接驱动，不走 ACP session/prompt
//   3. 从 agent.session.events 读 session/event（assistant/message）拿结果 —— 观察通道即日志
//   4. handle.dispose() 销毁
//   5. ctx.agents.resume({ resumeSessionId }) —— 原生恢复持久化会话，继续对话
// 全部走引擎原生 API，证明 server-ts 的编排逻辑可以搬进引擎进程。
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'helmsman-tasks-probe'
export const inject = ['agents', 'sessions']

export function apply(ctx) {
  // 与 headless 同款：等 loader 完成（scoped tools / adapters 装配完）再建 agent
  ctx.get('loader')?.await().then(async () => {
    try {
      await runProbe(ctx)
    } catch (err) {
      console.error('[tasks-probe] FAILED:', err?.message ?? err)
      process.exitCode = 1
    } finally {
      // 实验收尾：引擎进程优雅退出（不依赖 ACP 的 stdin EOF）
      process.exit()
    }
  })
}

async function runProbe(ctx) {
  const agents = ctx.agents
  const sessions = ctx.sessions
  const sid = SessionId(`probe-${randomUUID().slice(0, 8)}`)
  const cwd = process.env.HELMSMAN_WORKSPACE ?? process.cwd()
  console.log(`[tasks-probe] create agent session=${sid} cwd=${cwd}`)

  // 1. 引擎内建任务会话（等价 server-ts 的"新建任务"）
  const { agent, dispose } = await agents.create({
    sessionId: sid,
    meta: { cwd },
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    setup: (agentCtx) => {
      // 任务级装配接点：preset mount / model selection 都在这（官方扩展点）
      console.log('[tasks-probe] setup(agentCtx) ran — 任务级工具/人格装配点')
    },
  })
  console.log(`[tasks-probe] agent created id=${agent.id} status=${agent.status}`)

  // 2. 直接驱动一轮（等价 server-ts 的"提交评论/任务指令"）
  const firstSeq = agent.session.seq
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: '用一句话回答：1+1 等于几？只输出答案。' }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  await sessions.flush(agent.session)

  // 3. 从 session log 读结果（观察通道 —— 无需 tail JSONL，事件即日志）
  const assistantText = extractAssistantText(agent.session.events, firstSeq)
  console.log(`[tasks-probe] round-1 reply: ${JSON.stringify(assistantText)}`)

  // 4. 销毁（等价任务结束）
  await dispose()
  console.log('[tasks-probe] agent disposed')

  // 5. 原生 resume：同一会话恢复，继续对话（等价 server-ts 的"恢复历史任务"）
  const resumed = await agents.resume({
    resumeSessionId: sid,
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  })
  console.log(`[tasks-probe] resumed agent id=${resumed.agent.id} status=${resumed.agent.status}`)
  const secondSeq = resumed.agent.session.seq
  resumed.agent.followup(createUserMessage({
    content: [{ type: 'text', text: '继续：请复述你上一轮说的话。' }],
    source: { kind: 'user' },
  }))
  await resumed.agent.whenIdle()
  await sessions.flush(resumed.agent.session)
  const resumedText = extractAssistantText(resumed.agent.session.events, secondSeq)
  console.log(`[tasks-probe] round-2 reply: ${JSON.stringify(resumedText)}`)

  await resumed.dispose()
  console.log('[tasks-probe] OK — 引擎内建任务 + 原生 resume 链路全通')
}

/** 从 session log 事件里抽取某 seq 之后的最后一条 assistant/message 文本。 */
function extractAssistantText(events, afterSeq) {
  let text = ''
  for (const ev of events) {
    if (ev.seq === undefined || ev.seq <= afterSeq) continue
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
