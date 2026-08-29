/**
 * dsh 引擎子进程管理（TS 版）：spawn、ACP 握手、健康检查、优雅关闭。
 * 对应 crates/spawn + crates/control 的 P0 面。
 */
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { AcpClient } from './acp-client.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
/** dsh/ 目录（launcher.mjs 与 cordis.yml 所在）——相对本文件上溯一级。 */
export const DSH_DIR = resolve(HERE, '../../dsh')
export const LAUNCHER = resolve(DSH_DIR, 'launcher.mjs')
export const CORDIS = resolve(DSH_DIR, 'cordis.yml')

export interface EngineHandle {
  acp: AcpClient
  dispose(): Promise<void>
}

/** 引擎环境：会话日志落盘位置 + 工作区（照 Rust DshConfig.env）。 */
export interface EngineEnv {
  sessionsRoot: string
  workspace: string
}

/**
 * 拉起引擎并完成 initialize 握手。超时视为启动失败。
 */
export async function startEngine(
  env: EngineEnv,
  timeoutMs = 15000,
): Promise<EngineHandle> {
  const acp = new AcpClient(LAUNCHER, CORDIS, {
    cwd: DSH_DIR,
    env: {
      HELMSMAN_SESSIONS_ROOT: env.sessionsRoot,
      HELMSMAN_WORKSPACE: env.workspace,
      // 会话模型选择共享文件（引擎 model 插件读它，server 写它）
      HELMSMAN_MODEL_FILE: join(env.workspace, '.helmsman', 'model-selection.json'),
    },
  })
  const result = (await Promise.race([
    acp.initialize(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('dsh initialize timeout')), timeoutMs),
    ),
  ])) as { agentInfo?: { name?: string; version?: string } }
  console.log(`[engine] dsh up: ${result.agentInfo?.name ?? 'unknown'} ${result.agentInfo?.version ?? ''}`)
  return { acp, dispose: () => acp.dispose() }
}
