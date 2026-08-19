/**
 * 验收证据（便宜验收）：任务 Done 时拍一份工作区快照，给人看「改了什么」。
 * 不跑模型、不读全量 patch，只取 git status / diff --stat（超时 5s）。
 * 给人看改了什么再点批准。
 */
import { execFileSync } from 'node:child_process'
import type { VerifyResult } from './verify.ts'

export interface WorkspaceDiff {
  dirty: boolean
  files: string[]
  stat: string
  error?: string
}

export interface AcceptanceEvidence {
  setting: 'delivery'
  criteria: string | null
  verify: VerifyResult | null
  diff: WorkspaceDiff
  worktree?: { path: string; branch: string } | null
}

const GIT_OPTS = {
  timeout: 5000,
  encoding: 'utf8' as const,
  stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
}

export function collectWorkspaceDiff(cwd: string): WorkspaceDiff {
  try {
    runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
  } catch (e) {
    return {
      dirty: false,
      files: [],
      stat: '',
      error: e instanceof Error ? e.message.split('\n')[0] : String(e),
    }
  }
  const porcelain = tryGit(cwd, ['status', '--porcelain'])
  const files = porcelain
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 40)
  const stat = tryGit(cwd, ['diff', '--stat', 'HEAD']) || tryGit(cwd, ['diff', '--stat'])
  return {
    dirty: files.length > 0,
    files,
    stat: stat.slice(0, 800),
  }
}

export function buildAcceptanceEvidence(input: {
  cwd: string
  criteria: string | null
  verify: VerifyResult | null
  worktree?: { path: string; branch: string } | null
}): AcceptanceEvidence {
  return {
    setting: 'delivery',
    criteria: input.criteria,
    verify: input.verify,
    diff: collectWorkspaceDiff(input.cwd),
    worktree: input.worktree ?? null,
  }
}

/** 批复条上的一句话：有命令结果就说结果，否则只请人对照改动。 */
export function acceptanceReason(ev: AcceptanceEvidence): string {
  if (ev.verify?.verified === true) {
    return '交付设定：验收命令已通过，请对照改动确认后 merge'
  }
  if (ev.verify?.verified === false) {
    return '交付设定：验收命令未通过，请决定打回或仍合并'
  }
  if (ev.verify?.error) {
    return `交付设定：验收命令未能执行（${ev.verify.error}），请对照改动人工验收`
  }
  return '交付设定：任务完成，请对照改动验收（通过则 merge 知识）'
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, ...GIT_OPTS }).trim()
}

function tryGit(cwd: string, args: string[]): string {
  try {
    return runGit(cwd, args)
  } catch {
    return ''
  }
}
