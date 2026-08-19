/**
 * 便宜验收：工作区快照（git status / diff --stat），不跑模型。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectWorkspaceDiff, acceptanceReason, buildAcceptanceEvidence } from '../src/evidence.ts'

describe('工作区快照（便宜验收）', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hm-evidence-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('非 git 目录：dirty=false 且带 error', () => {
    const d = collectWorkspaceDiff(dir)
    expect(d.dirty).toBe(false)
    expect(d.files).toEqual([])
    expect(d.error).toBeTruthy()
  })

  it('干净仓库：无改动', () => {
    initRepo(dir)
    writeFileSync(join(dir, 'a.txt'), 'hello\n')
    git(dir, ['add', '.'])
    git(dir, ['commit', '-m', 'init'])
    const d = collectWorkspaceDiff(dir)
    expect(d.dirty).toBe(false)
    expect(d.files).toEqual([])
    expect(d.error).toBeUndefined()
  })

  it('有未提交改动：列出 porcelain 行 + stat', () => {
    initRepo(dir)
    writeFileSync(join(dir, 'a.txt'), 'hello\n')
    git(dir, ['add', '.'])
    git(dir, ['commit', '-m', 'init'])
    writeFileSync(join(dir, 'a.txt'), 'hello world\n')
    writeFileSync(join(dir, 'new.txt'), 'fresh\n')
    const d = collectWorkspaceDiff(dir)
    expect(d.dirty).toBe(true)
    expect(d.files.some((f) => f.includes('a.txt'))).toBe(true)
    expect(d.files.some((f) => f.includes('new.txt'))).toBe(true)
    expect(d.stat).toMatch(/a\.txt/)
  })

  it('验收原因按 verify 结果分句', () => {
    expect(acceptanceReason({
      setting: 'delivery',
      criteria: null,
      verify: null,
      diff: { dirty: false, files: [], stat: '' },
    })).toContain('对照改动验收')
    expect(acceptanceReason({
      setting: 'delivery',
      criteria: 'true',
      verify: { verified: true, exitCode: 0, durationMs: 10, outputTail: '' },
      diff: { dirty: true, files: [' M a.ts'], stat: '1 file' },
    })).toContain('已通过')
    expect(acceptanceReason({
      setting: 'delivery',
      criteria: 'false',
      verify: { verified: false, exitCode: 1, durationMs: 10, outputTail: 'fail' },
      diff: { dirty: false, files: [], stat: '' },
    })).toContain('未通过')
  })

  it('buildAcceptanceEvidence 带上 criteria + verify + diff', () => {
    initRepo(dir)
    const ev = buildAcceptanceEvidence({
      cwd: dir,
      criteria: 'exit 0',
      verify: { verified: true, exitCode: 0, durationMs: 3, outputTail: 'ok' },
    })
    expect(ev.setting).toBe('delivery')
    expect(ev.criteria).toBe('exit 0')
    expect(ev.verify?.verified).toBe(true)
    expect(ev.diff.error).toBeUndefined()
  })
})

function initRepo(cwd: string): void {
  mkdirSync(cwd, { recursive: true })
  git(cwd, ['init'])
  git(cwd, ['config', 'user.email', 't@t.test'])
  git(cwd, ['config', 'user.name', 't'])
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
