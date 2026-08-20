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

/** 项目是 git 仓库且有 HEAD 时，为这次执行开隔离工作区；否则返回 null（沿用项目目录）。 */
export function prepareTaskWorktree(repo: string, cardId: string, key: string): TaskWorktree | null {
  if (!isGitRepo(repo)) return null
  try {
    runGit(repo, ['rev-parse', '--verify', 'HEAD'])
  } catch {
    return null
  }
  ensureLocalExclude(repo)
  const branch = branchName(cardId, key)
  const path = join(repo, '.helmsman', 'worktrees', sanitize(key))
  mkdirSync(join(repo, '.helmsman', 'worktrees'), { recursive: true })
  try {
    runGit(repo, ['worktree', 'add', '-b', branch, path], { timeout: 30000 })
  } catch (e) {
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
      runGit(worktree.path, ['-c', 'commit.gpgsign=false', 'commit', '-m', message], { env: IDENT })
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
      runGit(repo, ['-c', 'commit.gpgsign=false', 'commit', '-m', message], { env: IDENT })
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
  try {
    runGit(repo, ['reset', '--merge'])
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
