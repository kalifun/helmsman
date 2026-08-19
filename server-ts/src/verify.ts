/**
 * 验收执行（§3.3 验收门 / §6C 实验 A 的"独立验证器"）：
 * 任务 Done 后，在项目目录跑验收命令（可判定断言），退出码 0 = 通过。
 * 验收独立于 agent 自评 —— "agent 说做完了"不等于"验收通过"（Cline #8354 反面）。
 * dogfood：任务级 worktree 并行探测（verify）。
 */
import { exec } from 'node:child_process'

export interface VerifyResult {
  /** true=通过 / false=失败 / null=验收不可执行（无命令/超时/异常） */
  verified: boolean | null
  exitCode: number | null
  durationMs: number
  outputTail: string
  error?: string
}

/**
 * 跑验收命令。`cwd` = 项目目录；`command` = 验收断言（如 `node -e "..."` / `npm test`）。
 * 超时默认 60s（防验收本身卡死）。
 */
export function runAcceptance(cwd: string, command: string, timeoutMs = 60000): Promise<VerifyResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    exec(command, { cwd, timeout: timeoutMs, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      const durationMs = Date.now() - started
      const out = (stdout + stderr).trim()
      const tail = out.slice(-400)
      if (error) {
        const code = (error as NodeJS.ErrnoException & { code?: number | string }).code
        if (typeof code === 'number') {
          // 命令跑完但退出码非 0 → 验收失败（明确结果）
          resolve({ verified: false, exitCode: code, durationMs, outputTail: tail })
        } else if ((error as { killed?: boolean }).killed) {
          // 超时被 kill
          resolve({ verified: null, exitCode: null, durationMs, outputTail: tail, error: `timeout after ${timeoutMs}ms` })
        } else {
          // spawn 本身失败（命令不存在等）
          resolve({ verified: null, exitCode: null, durationMs, outputTail: tail, error: error.message })
        }
        return
      }
      resolve({ verified: true, exitCode: 0, durationMs, outputTail: tail })
    })
  })
}
