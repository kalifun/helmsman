/**
 * ACP 客户端（TS 版）：newline-delimited JSON-RPC over dsh 子进程 stdin/stdout。
 * 照 crates/control（Rust 版）翻译；P0 覆盖 initialize / session/new / session/prompt / session/cancel。
 * 参考协议：https://agentclientprotocol.com
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'

export class AcpClient {
  private child: ChildProcessWithoutNullStreams
  private rl: Interface
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  constructor(
    launcherPath: string,
    cordisPath: string,
    opts: { env?: Record<string, string>; cwd?: string } = {},
  ) {
    this.child = spawn('node', [launcherPath, cordisPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...opts.env },
      cwd: opts.cwd,
    })
    this.rl = createInterface({ input: this.child.stdout })
    // stderr 透传（引擎诊断）：'pipe' 下手动转发，避免 'inherit' 与类型不一致
    this.child.stderr.on('data', (d) => process.stderr.write(d))
    this.rl.on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      let msg: { id?: number; result?: unknown; error?: unknown }
      try {
        msg = JSON.parse(trimmed)
      } catch {
        return // 非 JSON 行（诊断）丢弃
      }
      if (typeof msg.id === 'number') {
        const waiter = this.pending.get(msg.id)
        if (!waiter) return
        this.pending.delete(msg.id)
        if (msg.error !== undefined) waiter.reject(new Error(`ACP error: ${JSON.stringify(msg.error)}`))
        else waiter.resolve(msg.result)
      }
      // 穿插通知（session/update 等）P0 阶段丢弃。
    })
    this.child.on('exit', (code) => {
      for (const waiter of Array.from(this.pending.values())) waiter.reject(new Error(`dsh exited with code ${code}`))
      this.pending.clear()
    })
  }

  private call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = this.nextId++
    const req = { jsonrpc: '2.0', id, method, params }
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.child.stdin.write(`${JSON.stringify(req)}\n`)
    })
  }

  initialize(): Promise<unknown> {
    return this.call('initialize', { protocolVersion: 1 })
  }

  /** 每任务一个会话（与"一个 task 一个 sessionId"对齐）。
   *  presetId：按 agent preset 组装会话（每任务工具/人格；经 dsh-acp patch 透传 _meta.agentPreset）。 */
  async sessionNew(cwd: string, presetId?: string): Promise<string> {
    const r = await this.call<{ sessionId: string }>('session/new', {
      cwd,
      additionalDirectories: [],
      mcpServers: [],
      ...(presetId ? { _meta: { agentPreset: presetId } } : {}),
    })
    return r.sessionId
  }

  /** 发一条文本 prompt，阻塞到 agent idle（end_turn / cancelled）。 */
  async sessionPrompt(sessionId: string, text: string): Promise<string> {
    const r = await this.call<{ stopReason: string }>('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }],
    })
    return r.stopReason
  }

  sessionCancel(sessionId: string): Promise<unknown> {
    return this.call('session/cancel', { sessionId })
  }

  async dispose(): Promise<void> {
    this.rl.close()
    this.child.kill('SIGTERM')
  }
}
