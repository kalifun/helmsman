/**
 * 任务级 worktree：每条执行一个分支 + 检出目录，agent 不写主工作区。
 * 验收批准（或非交付档自动 Done）再合回；拒绝则丢掉。非 git 项目原样用项目目录。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface TaskWorktree {
  path: string
  branch: string
}

export interface MergeResult {
  ok: boolean
  committed: boolean
  merged: boolean
  conflicts?: string[]
  error?: string
}

const IDENT = {
  GIT_AUTHOR_NAME: 'Helmsman',
  GIT_AUTHOR_EMAIL: 'helmsman@local',
  GIT_COMMITTER_NAME: 'Helmsman',
  GIT_COMMITTER_EMAIL: 'helmsman@local',
}

export function executionCwd(projectPath: string, worktree?: TaskWorktree | null): string {
  return worktree?.path ?? projectPath
}

/** 会话 cwd 是否落在任务隔离区（`.helmsman/worktrees/…`），不能当独立项目。 */
export function isTaskWorktreePath(p: string): boolean {
  const n = p.replace(/\\/g, '/')
  return n.includes('/.helmsman/worktrees/') || n.endsWith('/.helmsman/worktrees')
}

/** 隔离区路径收回到仓库根；普通 cwd 原样。 */
export function repoRootFromCwd(cwd: string): string {
  const n = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  const marker = '/.helmsman/worktrees/'
  const i = n.indexOf(marker)
  if (i >= 0) return n.slice(0, i)
  if (n.endsWith('/.helmsman/worktrees')) return n.slice(0, -'/.helmsman/worktrees'.length)
  return n
}

/** 项目是 git 仓库且有 HEAD 时，为这次执行开隔离工作区；否则返回 null（沿用项目目录）。 */
export function prepareTaskWorktree(repo: string, cardId: string, key: string): TaskWorktree | null {
  if (!isGitRepo(repo)) {
    console.warn(`[worktree] 非 git 仓库，隔离区不可用（${repo}）—— 回退共享项目目录`)
    return null
  }
  try {
    runGit(repo, ['rev-parse', '--verify', 'HEAD'])
  } catch {
    console.warn(`[worktree] 仓库无 HEAD（${repo}）—— 回退共享项目目录`)
    return null
  }
  ensureLocalExclude(repo)
  const branch = branchName(cardId, key)
  const path = join(repo, '.helmsman', 'worktrees', sanitize(key))
  mkdirSync(join(repo, '.helmsman', 'worktrees'), { recursive: true })
  try {
    runGit(repo, ['worktree', 'add', '-b', branch, path], { timeout: 30000 })
  } catch (e) {
    const msg = e instanceof Error ? e.message.split('\n')[0] : String(e)
    console.warn(`[worktree] 隔离区创建失败（${repo}，${msg}）—— 回退共享项目目录`)
    return nullIfExists(e, path, branch)
  }
  return { path, branch }
}

export function mergeTaskWorktree(input: {
  repo: string
  worktree: TaskWorktree
  message: string
}): MergeResult {
  const { repo, worktree, message } = input
  let committed = false
  try {
    if (isDirty(worktree.path)) {
      runGit(worktree.path, ['add', '-A'])
      runGit(worktree.path, ['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', message], { env: IDENT })
      committed = true
    }
  } catch (e) {
    return { ok: false, committed, merged: false, error: `隔离区提交失败：${errMsg(e)}` }
  }
  const ahead = commitsAhead(repo, worktree.branch)
  if (!ahead) {
    discardTaskWorktree(repo, worktree)
    return { ok: true, committed, merged: false }
  }
  try {
    // squash：主树一条提交，避免隔离区 commit + --no-ff 再记一条。
    runGit(repo, ['merge', '--squash', worktree.branch])
    if (hasStaged(repo)) {
      runGit(repo, ['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', message], { env: IDENT })
    }
  } catch (e) {
    const conflicts = conflictedFiles(repo)
    abortMerge(repo)
    return {
      ok: false,
      committed,
      merged: false,
      conflicts,
      error: conflicts.length
        ? `合入冲突：${conflicts.slice(0, 8).join('、')}`
        : `合入主工作区失败：${errMsg(e)}`,
    }
  }
  discardTaskWorktree(repo, worktree)
  return { ok: true, committed, merged: true }
}

/**
 * 启动清理：删除隔离区（.helmsman/worktrees/）下所有残留 worktree —— 崩溃/中断执行泄漏
 * （正常任务完成时已 merge/discard；此处只清残留）。返回清理数量。
 */
export function cleanupLeakedWorktrees(repo: string): number {
  if (!isGitRepo(repo)) return 0
  let cleaned = 0
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repo, encoding: 'utf8', timeout: 10000,
    })
    // porcelain 块：worktree <path> / HEAD <hash> / branch refs/heads/<name> / 空行
    let curPath = ''
    let curBranch = ''
    const flush = (): void => {
      if (curPath && curPath.includes('/.helmsman/worktrees/') && curBranch) {
        try {
          discardTaskWorktree(repo, { path: curPath, branch: curBranch })
          cleaned++
        } catch { /* 清理失败不阻塞启动 */ }
      }
      curPath = ''
      curBranch = ''
    }
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) {
        flush()
        curPath = line.slice('worktree '.length).trim()
      } else if (line.startsWith('branch refs/heads/')) {
        curBranch = line.slice('branch refs/heads/'.length).trim()
      } else if (line.trim() === '') {
        flush()
      }
    }
    flush()
  } catch { return 0 }
  return cleaned
}

export function discardTaskWorktree(repo: string, worktree: TaskWorktree): void {
  try {
    runGit(repo, ['worktree', 'remove', '--force', worktree.path], { timeout: 20000 })
  } catch {
    try {
      runGit(repo, ['worktree', 'prune'])
    } catch { /* ignore */ }
  }
  try {
    runGit(repo, ['branch', '-D', worktree.branch])
  } catch { /* 分支可能已删 */ }
}

function isGitRepo(cwd: string): boolean {
  try {
    runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
    return true
  } catch {
    return false
  }
}

function isDirty(cwd: string): boolean {
  try {
    return runGit(cwd, ['status', '--porcelain']).length > 0
  } catch {
    return false
  }
}

function commitsAhead(repo: string, branch: string): boolean {
  try {
    const n = runGit(repo, ['rev-list', '--count', `HEAD..${branch}`])
    return Number(n) > 0
  } catch {
    return false
  }
}

function hasStaged(repo: string): boolean {
  try {
    runGit(repo, ['diff', '--cached', '--quiet'])
    return false
  } catch {
    return true
  }
}

function abortMerge(repo: string): void {
  try {
    runGit(repo, ['merge', '--abort'])
  } catch { /* squash 冲突不一定有 MERGE_HEAD */ }
  // S2：只有确有未解决的冲突才 reset --merge（恢复冲突标记）；
  // 无冲突失败（脏树拒绝 / hook 失败）时绝不碰 index —— reset --merge 会抹掉用户已暂存未提交的改动
  try {
    const conflicts = conflictedFiles(repo)
    if (conflicts.length > 0) runGit(repo, ['reset', '--merge'])
  } catch { /* 已经干净就算了 */ }
}

function conflictedFiles(repo: string): string[] {
  try {
    return runGit(repo, ['diff', '--name-only', '--diff-filter=U'])
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function ensureLocalExclude(repo: string): void {
  const file = join(repo, '.git', 'info', 'exclude')
  const line = '.helmsman/'
  try {
    const cur = existsSync(file) ? readFileSync(file, 'utf8') : ''
    if (cur.split('\n').some((l) => l.trim() === line)) return
    mkdirSync(join(repo, '.git', 'info'), { recursive: true })
    appendFileSync(file, (cur.endsWith('\n') || cur.length === 0 ? '' : '\n') + line + '\n')
  } catch { /* 写不进 exclude 不挡启动，最多主树多一堆未跟踪 */ }
}

function branchName(cardId: string, key: string): string {
  return `helmsman/${sanitize(cardId).slice(0, 40)}/${sanitize(key).slice(0, 24)}`
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'x'
}

function nullIfExists(e: unknown, _path: string, _branch: string): TaskWorktree | null {
  console.warn(`[worktree] add failed: ${errMsg(e)}`)
  return null
}

function errMsg(e: unknown): string {
  if (!(e instanceof Error)) return String(e)
  const extra = e as Error & { stderr?: string }
  const raw = typeof extra.stderr === 'string' && extra.stderr.trim() ? extra.stderr : e.message
  return raw.trim().split('\n')[0] ?? e.message
}

function runGit(
  cwd: string,
  args: string[],
  opts: { timeout?: number; env?: Record<string, string> } = {},
): string {
  return execFileSync('git', args, {
    cwd,
    timeout: opts.timeout ?? 15000,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...opts.env },
  }).trim()
}
