/**
 * 任务级 worktree：并行执行隔离，合入 / 冲突 / 丢弃。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareTaskWorktree, mergeTaskWorktree, discardTaskWorktree, isTaskWorktreePath, repoRootFromCwd } from '../src/worktree.ts'

describe('任务级 worktree', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hm-wt-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('非 git 目录：不建 worktree', () => {
    expect(prepareTaskWorktree(dir, 'card-1', 'k1')).toBeNull()
  })

  it('两路并行改不同文件，先后合入主树都在', () => {
    initRepo(dir)
    const a = prepareTaskWorktree(dir, 'card-a', 'run-a')
    const b = prepareTaskWorktree(dir, 'card-b', 'run-b')
    expect(a).toBeTruthy()
    expect(b).toBeTruthy()
    writeFileSync(join(a!.path, 'alpha.txt'), 'A\n')
    writeFileSync(join(b!.path, 'beta.txt'), 'B\n')
    expect(existsSync(join(dir, 'alpha.txt'))).toBe(false)
    expect(existsSync(join(dir, 'beta.txt'))).toBe(false)

    const ma = mergeTaskWorktree({ repo: dir, worktree: a!, message: 'helmsman: a' })
    const mb = mergeTaskWorktree({ repo: dir, worktree: b!, message: 'helmsman: b' })
    expect(ma.ok).toBe(true)
    expect(mb.ok).toBe(true)
    expect(readFileSync(join(dir, 'alpha.txt'), 'utf8')).toBe('A\n')
    expect(readFileSync(join(dir, 'beta.txt'), 'utf8')).toBe('B\n')
  })

  it('两路改同一文件：第二路合入报冲突，主树保持第一路', () => {
    initRepo(dir)
    writeFileSync(join(dir, 'same.txt'), 'base\n')
    git(dir, ['add', '.'])
    git(dir, ['commit', '-m', 'base'])
    const a = prepareTaskWorktree(dir, 'card-a', 'run-a')!
    const b = prepareTaskWorktree(dir, 'card-b', 'run-b')!
    writeFileSync(join(a.path, 'same.txt'), 'from-a\n')
    writeFileSync(join(b.path, 'same.txt'), 'from-b\n')
    expect(mergeTaskWorktree({ repo: dir, worktree: a, message: 'a' }).ok).toBe(true)
    const mb = mergeTaskWorktree({ repo: dir, worktree: b, message: 'b' })
    expect(mb.ok).toBe(false)
    expect(mb.conflicts?.some((f) => f.includes('same.txt'))).toBe(true)
    expect(readFileSync(join(dir, 'same.txt'), 'utf8')).toBe('from-a\n')
  })

  it('丢弃：隔离区改动不进主树', () => {
    initRepo(dir)
    const a = prepareTaskWorktree(dir, 'card-a', 'run-x')!
    writeFileSync(join(a.path, 'gone.txt'), 'nope\n')
    discardTaskWorktree(dir, a)
    expect(existsSync(join(dir, 'gone.txt'))).toBe(false)
    expect(existsSync(a.path)).toBe(false)
  })

  it('无改动合入：成功且不产生空提交', () => {
    initRepo(dir)
    const a = prepareTaskWorktree(dir, 'card-a', 'empty')!
    const r = mergeTaskWorktree({ repo: dir, worktree: a, message: 'noop' })
    expect(r.ok).toBe(true)
    expect(r.committed).toBe(false)
    expect(r.merged).toBe(false)
  })

  it('合入主树只多一条提交', () => {
    initRepo(dir)
    const before = Number(git(dir, ['rev-list', '--count', 'HEAD']))
    const a = prepareTaskWorktree(dir, 'card-a', 'one')!
    writeFileSync(join(a.path, 'only.txt'), '1\n')
    expect(mergeTaskWorktree({ repo: dir, worktree: a, message: 'helmsman: a' }).ok).toBe(true)
    expect(Number(git(dir, ['rev-list', '--count', 'HEAD']))).toBe(before + 1)
    expect(git(dir, ['log', '-1', '--pretty=%s'])).toBe('helmsman: a')
  })

  it('隔离区路径能收回仓库根', () => {
    const repo = '/tmp/helmsman'
    const wt = `${repo}/.helmsman/worktrees/card-x`
    expect(isTaskWorktreePath(wt)).toBe(true)
    expect(isTaskWorktreePath(repo)).toBe(false)
    expect(repoRootFromCwd(wt)).toBe(repo)
  })
})

function initRepo(cwd: string): void {
  mkdirSync(cwd, { recursive: true })
  git(cwd, ['init'])
  git(cwd, ['config', 'user.email', 't@t.test'])
  git(cwd, ['config', 'user.name', 't'])
  writeFileSync(join(cwd, 'README.md'), 'seed\n')
  git(cwd, ['add', '.'])
  git(cwd, ['commit', '-m', 'init'])
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** 补充：L1/M5 相关（worktree 语义） */
import { describe, expect, it } from 'vitest'
import { isTaskWorktreePath, repoRootFromCwd } from '../src/worktree.ts'

describe('worktree 路径语义（review 补充）', () => {
  it('isTaskWorktreePath 识别隔离区', () => {
    expect(isTaskWorktreePath('/repo/.helmsman/worktrees/card-1')).toBe(true)
    expect(isTaskWorktreePath('/repo/.helmsman/worktrees')).toBe(true)
    expect(isTaskWorktreePath('/repo/src')).toBe(false)
  })

  it('repoRootFromCwd 隔离区路径收回仓库根', () => {
    expect(repoRootFromCwd('/repo/.helmsman/worktrees/card-1')).toBe('/repo')
    expect(repoRootFromCwd('/repo/.helmsman/worktrees')).toBe('/repo')
    expect(repoRootFromCwd('/repo/src')).toBe('/repo/src')
  })
})
