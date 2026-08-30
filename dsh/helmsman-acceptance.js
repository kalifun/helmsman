// [helmsman] D3-6 验收门（engine evidence/verify 迁移）。
// 任务 Done 且卡有验收标准（criteria）→ 跑验收命令 + 拍工作区 git 快照，
// 产出 AcceptanceEvidence 给人看「改了什么」再决定 merge/打回。
//   - 项目默认 profile.setting === 'delivery' 且 approval !== 'yolo' → 挂起 acceptance 审批
//   - 否则 → 直接 merge worktree（v1 行为）
// 迁移源：server-ts/src/evidence.ts + verify.ts（纯 Node 函数，无 ACP 依赖）。
import { exec, execFileSync } from 'node:child_process'

export const name = 'helmsman-acceptance'
export const inject = ['agents', 'sessions', 'helmsmanBoard', 'helmsmanStorage', 'helmsmanWorktree', 'webServer']

// ---------- 纯函数：从 server-ts/evidence.ts + verify.ts 原样搬 ----------

const GIT_OPTS = { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }

function runGit(cwd, args) {
  return execFileSync('git', args, { cwd, ...GIT_OPTS }).trim()
}
function tryGit(cwd, args) {
  try { return runGit(cwd, args) } catch { return '' }
}

/** 工作区 diff 快照（git status --porcelain + diff --stat HEAD）。 */
function collectWorkspaceDiff(cwd) {
  try {
    runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
  } catch (e) {
    return { dirty: false, files: [], stat: '', error: (e?.message ?? String(e)).split('\n')[0] }
  }
  const porcelain = tryGit(cwd, ['status', '--porcelain'])
  const files = porcelain.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 40)
  const stat = tryGit(cwd, ['diff', '--stat', 'HEAD']) || tryGit(cwd, ['diff', '--stat'])
  return { dirty: files.length > 0, files, stat: stat.slice(0, 800) }
}

/** 验收证据：setting + criteria + verify 结果 + 工作区 diff + worktree。 */
function buildAcceptanceEvidence({ cwd, criteria, verify, worktree }) {
  return {
    setting: 'delivery',
    criteria: criteria ?? null,
    verify: verify ?? null,
    diff: collectWorkspaceDiff(cwd),
    worktree: worktree ?? null,
  }
}

/** 批复条上的一句话。 */
function acceptanceReason(ev) {
  if (ev.verify?.verified === true) return '交付设定：验收命令已通过，请对照改动确认后 merge'
  if (ev.verify?.verified === false) return '交付设定：验收命令未通过，请决定打回或仍合并'
  if (ev.verify?.error) return `交付设定：验收命令未能执行（${ev.verify.error}），请对照改动人工验收`
  return '交付设定：任务完成，请对照改动验收（通过则 merge 知识）'
}

/** 跑验收命令：退出码 0 = 通过；超时/无法执行 = null（不可判定）。 */
function runAcceptance(cwd, command, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const started = Date.now()
    exec(command, { cwd, timeout: timeoutMs, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      const durationMs = Date.now() - started
      const tail = (stdout + stderr).trim().slice(-400)
      if (error) {
        const code = error.code
        if (typeof code === 'number') {
          resolve({ verified: false, exitCode: code, durationMs, outputTail: tail })
        } else if (error.killed) {
          resolve({ verified: null, exitCode: null, durationMs, outputTail: tail, error: `timeout after ${timeoutMs}ms` })
        } else {
          resolve({ verified: null, exitCode: null, durationMs, outputTail: tail, error: error.message })
        }
        return
      }
      resolve({ verified: true, exitCode: 0, durationMs, outputTail: tail })
    })
  })
}

// ---------- 插件主体 ----------

export function apply(ctx) {
  const board = ctx.get('helmsmanBoard')
  const storage = ctx.get('helmsmanStorage')?.storage
  const worktree = ctx.get('helmsmanWorktree')
  const gated = new Set() // 已过验收门的 (sid, turn) 防重复

  /** 从投影取任务执行态。 */
  const getExecution = (sid) => {
    const pid = board?.projection?.sessionProject?.[sid]
    if (!pid) return null
    const cardId = board?.projection?.sessionCard?.[sid]
    const proj = board?.projection?.projects?.[pid]
    if (!proj) return null
    const t = cardId ? proj.cards?.[cardId]?.executions?.[sid] : proj.chats?.[sid]
    if (!t) return null
    return { pid, cardId, proj, t, card: cardId ? proj.cards?.[cardId] : undefined }
  }

  /** 验收门：任务 Done + 卡有 criteria → 跑验收 + 拍证据 → 挂起 acceptance 或直接 merge。 */
  async function runGate(sid) {
    const found = getExecution(sid)
    if (!found) return null
    const { pid, cardId, proj, t, card } = found
    if (!cardId || !card) return null // 仅卡片执行（chats 无验收门）
    // 运行目录：worktree 隔离区优先，否则项目目录
    const runCwd = t.worktree?.path ?? proj.path
    const criteria = card.criteria ?? null
    // 项目默认 profile 决定是否挂起验收（v1：preset.setting === 'delivery' && approval !== 'yolo'）
    const prof = storage?.defaultProfile(pid)
    const hang = prof?.setting === 'delivery' && prof?.approval !== 'yolo'
    // 有验收标准才跑验收命令；无标准 → 直接人工对照改动
    const verify = criteria ? await runAcceptance(runCwd, criteria) : null
    const evidence = buildAcceptanceEvidence({ cwd: runCwd, criteria, verify, worktree: t.worktree })
    if (hang) {
      const reason = acceptanceReason(evidence)
      // 挂起：任务停在等待批复（投影 waiting 保留 Done 后的等待态）
      t.waiting = { kind: 'acceptance', reason, payload: evidence }
      if (storage) {
        storage.insertApproval({
          project_id: pid, execution_id: sid, kind: 'acceptance',
          payload: evidence, reason, outcome: null, comment: null, created_at: Date.now(),
        })
      }
      console.log(`[helmsman-acceptance] 挂起验收 ${sid} criteria=${criteria ? '有' : '无'} verify=${verify?.verified ?? 'n/a'} files=${evidence.diff.files.length}`)
      return { gated: true, reason }
    }
    // 非 delivery / yolo：直接 merge 回主工作区
    if (t.worktree && worktree) {
      const mr = worktree.merge({ repo: proj.path, worktree: t.worktree, message: `helmsman: ${card.title}` })
      if (mr.ok) {
        t.worktree = null
        console.log(`[helmsman-acceptance] 自动 merge ${sid}（非 delivery 设定）`)
      } else {
        console.warn(`[helmsman-acceptance] merge 失败 ${sid}: ${mr.message}`)
      }
    }
    return { gated: false }
  }

  // 监听任务 Done（与 kb 自动沉淀同一事件源）
  ctx.on('session/event', (session, event) => {
    if (!session?.id || event?.type !== 'turn/end') return
    const sid = session.id
    const key = `${sid}:${event.data?.turn}`
    if (gated.has(key)) return
    const found = getExecution(sid)
    if (!found || !found.cardId) return
    if (found.t.status !== 'Done') return
    // 任务确实做过事（有 Text 输出）才触发验收门
    const texts = (found.t.activities ?? []).filter((a) => 'Text' in a)
    if (texts.length === 0) return
    gated.add(key)
    void runGate(sid).catch((e) => console.error('[helmsman-acceptance] 验收门失败:', e?.message ?? e))
  })

  // 决策：POST /api/approvals/:id 由 helmsman-approval 处理；这里提供 merge 服务供其调用
  ctx.provide('helmsmanAcceptance', {
    /** 批准 → merge worktree（approval 插件决策时调用）。 */
    approveMerge(sid) {
      const found = getExecution(sid)
      if (!found?.t?.worktree || !worktree) return { ok: false, message: 'no worktree' }
      const mr = worktree.merge({
        repo: found.proj.path,
        worktree: found.t.worktree,
        message: `helmsman: ${found.card?.title ?? sid}`,
      })
      if (mr.ok) {
        found.t.worktree = null
        found.t.waiting = null
      }
      return mr.ok ? { ok: true } : { ok: false, message: mr.message }
    },
    /** 拒绝 → 清除等待态（不 merge，worktree 保留待人工处理）。 */
    rejectClear(sid) {
      const found = getExecution(sid)
      if (found?.t) found.t.waiting = null
      return { ok: true }
    },
    /** 测试钩子：手动触发验收门（供 API 探活）。 */
    runGate,
  })

  console.log('[helmsman-acceptance] 验收门已挂载（Done → verify + evidence → 挂起/merge）')
}

export default { name, inject, apply }
