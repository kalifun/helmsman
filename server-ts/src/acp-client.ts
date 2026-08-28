/**
 * ACP 客户端（TS 版）：newline-delimited JSON-RPC over dsh 子进程 stdin/stdout。
 * 照 crates/control（Rust 版）翻译；P0 覆盖 initialize / session/new / session/prompt / session/cancel。
 * 参考协议：https://agentclientprotocol.com
 *
 * P1 命令级白名单：新增 session/request_permission 请求处理。
 * 引擎（agent 侧）在工具需要授权时（tools/pre-execute → ask → approval 桥）向本客户端
 * 发 `session/request_permission` JSON-RPC 请求（带 id）。本客户端把请求挂起，
 * 经 onPermission 回调交给业务侧（批复队列 Waiting{permission}），用户决策后
 * 由 respondPermission 回复引擎。turn 在此期间保持挂起（sessionPrompt 阻塞等待）。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'

/** 引擎发来的权限请求（对应协议 RequestPermissionRequest）。 */
export interface PermissionRequest {
  sessionId: string
  toolCall: {
    toolCallId: string
    name?: string
    arguments?: Record<string, unknown>
    content?: unknown
    /** 开放扩展缝（引擎桥透传审批原因等）。 */
    _meta?: { reason?: string }
  }
  options: Array<{ optionId: string; name: string; kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' }>
}

/** 权限决策回复（对应协议 RequestPermissionResponse —— outcome 是嵌套对象）。 */
export interface PermissionResponse {
  outcome:
    | { outcome: 'cancelled' }
    | { outcome: 'selected'; optionId: string }
}

/** 便捷构造：批准（allow-once / reject-once）。 */
export function permissionSelected(optionId: string): PermissionResponse {
  return { outcome: { outcome: 'selected', optionId } }
}

/** 便捷构造：取消。 */
export function permissionCancelled(): PermissionResponse {
  return { outcome: { outcome: 'cancelled' } }
}

export interface AcpClientOptions {
  env?: Record<string, string>
  cwd?: string
  /** 收到 session/request_permission 请求时回调。返回 Promise 挂起，直到 respondPermission 回复。 */
  onPermission?: (req: PermissionRequest) => void
}

export class AcpClient {
  private child: ChildProcessWithoutNullStreams
  private rl: Interface
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  /** 待回复的权限请求：callId → JSON-RPC id（回复时按 id 回）。 */
  private permissionById = new Map<string, number>()
  private onPermission?: (req: PermissionRequest) => void

  constructor(
    launcherPath: string,
    cordisPath: string,
    opts: AcpClientOptions = {},
  ) {
    this.onPermission = opts.onPermission
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
      let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown }
      try {
        msg = JSON.parse(trimmed)
      } catch {
        return // 非 JSON 行（诊断）丢弃
      }
      // 请求（带 method，来自引擎 → 需要回复）
      if (typeof msg.id === 'number' && typeof msg.method === 'string') {
        this.handleRequest(msg.id, msg.method, msg.params)
        return
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

  private handleRequest(id: number, method: string, params: unknown): void {
    if (method !== 'session/request_permission') {
      // 未知客户端方法：回错（协议要求请求必须有响应）
      this.child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })}\n`,
      )
      return
    }
    const p = (params ?? {}) as Partial<PermissionRequest>
    const sessionId = typeof p.sessionId === 'string' ? p.sessionId : ''
    const toolCall = (p.toolCall ?? {}) as PermissionRequest['toolCall']
    const callId = typeof toolCall?.toolCallId === 'string' ? toolCall.toolCallId : ''
    const req: PermissionRequest = {
      sessionId,
      toolCall: {
        toolCallId: callId,
        name: typeof toolCall?.name === 'string' ? toolCall.name : undefined,
        arguments: toolCall?.arguments as Record<string, unknown> | undefined,
        content: toolCall?.content,
        _meta: (toolCall?._meta as { reason?: string } | undefined) ?? undefined,
      },
      options: Array.isArray(p.options) ? p.options : [],
    }
    if (callId) this.permissionById.set(callId, id)
    // 交给业务侧（index.ts 注入的回调）。若无人处理，按取消回复（fail-closed）。
    if (this.onPermission) {
      try {
        this.onPermission(req)
        return
      } catch {
        // 回调抛错 → 按取消回复
      }
    }
    this.respondPermission(callId, { outcome: { outcome: 'cancelled' } })
  }

  /** 回复一个权限请求（用户已决策）。 */
  respondPermission(callId: string, resp: PermissionResponse): void {
    const id = this.permissionById.get(callId)
    if (id === undefined) return
    this.permissionById.delete(callId)
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: resp })}\n`)
  }

  /** 运行时注入权限回调（引擎启动时业务侧 storage/proj 尚未就绪，启动完成后设置）。 */
  setOnPermission(cb: (req: PermissionRequest) => void): void {
    this.onPermission = cb
  }

  /** 权限请求是否仍在等待回复（决策中）。 */
  hasPendingPermission(callId: string): boolean {
    return this.permissionById.has(callId)
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

  /** 恢复持久化会话（session/resume，dsh-acp patch 支持）：服务重启后历史会话继续。
   *  sessionId 必须已存在于会话日志（JSONL）；cwd 决定日志目录。 */
  async sessionResume(sessionId: string, cwd: string, presetId?: string): Promise<string> {
    const r = await this.call<{ sessionId: string }>('session/resume', {
      sessionId,
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
