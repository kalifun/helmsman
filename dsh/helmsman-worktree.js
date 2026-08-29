// [helmsman] D3-4 任务级 worktree 插件（引擎内化）。
// 迁移点：worktree.ts 是纯 Node git 函数（无 ACP 依赖），原样搬入。
// 引擎形态优势：tasks 插件建任务时 meta.cwd 直接用 worktree 路径，
// agent 天然在隔离区执行（v1 要 server 换 cwd 再过 ACP 传 sessionNew）。
// 接口：
//   POST /api/worktree/prepare  {repo, card_id, key} → {path, branch} | {ok:false,reason}
//   POST /api/worktree/merge    {repo, worktree, message} → MergeResult
//   POST /api/worktree/discard  {repo, worktree} → {ok:true}
import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'helmsman-worktree'
export const inject = ['webServer']

// ---------- 纯函数：从 server-ts/worktree.ts 原样搬 ----------

function runGit(repo, args, opts = {}) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeout ?? 10000,
  }).trim()
}

function isGitRepo(cwd) {
  try {
    runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
    return true
  } catch {
    return false
  }
}

function sanitize(key) {
  return String(key ?? 'task').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 60)
}

function branchName(cardId, key) {
  const k = sanitize(key)
  return `helmsman/${cardId}-${k.slice(0, 20)}`
}

/** 确保 .helmsman 目录不被 agent 的 git 操作污染（local exclude）。 */
function ensureLocalExclude(repo) {
  const info = join(repo, '.git', 'info', 'exclude')
  const line = '\n.helmsman/worktrees/\n'
  try {
    if (existsSync(info)) {
      const cur = readFileSync(info, 'utf8')
      if (!cur.includes('.helmsman/worktrees/')) appendFileSync(info, line)
    }
  } catch { /* 忽略 */ }
}

/** 准备任务隔离区：git worktree add -b <branch> <path>。非 git 仓库 → null（回退共享目录）。 */
function prepareTaskWorktree(repo, cardId, key) {
  if (!isGitRepo(repo)) {
    console.warn(`[helmsman-worktree] 非 git 仓库，隔离区不可用（${repo}）—— 回退共享项目目录`)
    return null
  }
  try {
    runGit(repo, ['rev-parse', '--verify', 'HEAD'])
  } catch {
    console.warn(`[helmsman-worktree] 仓库无 HEAD（${repo}）—— 回退共享项目目录`)
    return null
  }
  ensureLocalExclude(repo)
  const branch = branchName(cardId, key)
  const path = join(repo, '.helmsman', 'worktrees', sanitize(key))
  mkdirSync(join(repo, '.helmsman', 'worktrees'), { recursive: true })
  try {
    runGit(repo, ['worktree', 'add', '-b', branch, path], { timeout: 30000 })
  } catch {
    console.warn(`[helmsman-worktree] 隔离区创建失败（${repo}）—— 回退共享项目目录`)
    return null
  }
  return { path, branch }
}

/** 合回主工作区：add → commit → merge --no-ff。返回 {ok, message}。 */
function mergeTaskWorktree(input) {
  const { repo, worktree, message } = input
  try {
    runGit(worktree.path, ['add', '-A'])
    const hasChanges = runGit(worktree.path, ['status', '--porcelain'])
    if (!hasChanges) return { ok: true, message: 'no changes to merge' }
    runGit(worktree.path, ['commit', '-m', message ?? 'helmsman: task worktree merge'], { timeout: 30000 })
    runGit(repo, ['merge', '--no-ff', worktree.branch, '-m', message ?? 'helmsman: merge task worktree'], { timeout: 30000 })
    return { ok: true, message: 'merged' }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message.split('\n')[0] : String(e) }
  }
}

/** 丢弃隔离区：git worktree remove --force。 */
function discardTaskWorktree(repo, worktree) {
  try {
    runGit(repo, ['worktree', 'remove', '--force', worktree.path], { timeout: 30000 })
    return true
  } catch {
    return false
  }
}

// ---------- 插件主体：路由 ----------

export function apply(ctx) {
  const { webServer } = ctx
  // 内部服务：供 helmsman-tasks 建任务时自动隔离
  ctx.provide('helmsmanWorktree', {
    prepare: (repo, cardId, key) => prepareTaskWorktree(repo, cardId, key),
    discard: (repo, worktree) => discardTaskWorktree(repo, worktree),
    merge: (input) => mergeTaskWorktree(input),
  })
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

  webServer.register({
    kind: 'prefix',
    path: '/api/worktree',
    handler: async (req, res) => {
      const pathname = (req.url ?? '').split('?')[0]
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
      try {
        const body = await readBody(req)
        if (pathname === '/api/worktree/prepare') {
          const wt = prepareTaskWorktree(body.repo, body.card_id ?? 'card', body.key ?? 'task')
          if (!wt) return json(res, 200, { ok: false, reason: 'worktree unavailable' })
          return json(res, 201, { ok: true, path: wt.path, branch: wt.branch })
        }
        if (pathname === '/api/worktree/merge') {
          const r = mergeTaskWorktree({ repo: body.repo, worktree: body.worktree, message: body.message })
          return json(res, 200, r)
        }
        if (pathname === '/api/worktree/discard') {
          const ok = discardTaskWorktree(body.repo, body.worktree)
          return json(res, 200, { ok })
        }
        return json(res, 404, { error: 'not found' })
      } catch (e) {
        return json(res, 500, { error: e?.message ?? String(e) })
      }
    },
  })

  console.log('[helmsman-worktree] worktree 路由已注册：/api/worktree/*')
}

export default { name, inject, apply }
