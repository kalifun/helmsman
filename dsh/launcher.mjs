#!/usr/bin/env node
// helmsman 引擎启动器：用 dsh-app-boot 启动我们的 cordis.yml。
// 用法：node launcher.mjs [path/to/cordis.yml]（默认 ./cordis.yml）
// stdout 保留给 ACP JSON-RPC；诊断走 stderr。

import { existsSync } from 'node:fs'
import { boot, installFailLoud, loadLayeredEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'

const NAME = 'helmsman'
installFailLoud(NAME)
// 分层加载：继承环境 > 项目 .env（cwd）> Harness home .env（~/.dsh/.env，含 DEEPSEEK_API_KEY）
loadLayeredEnv(NAME)

const requested = process.env['HELMSMAN_CORDIS'] ?? process.argv[2] ?? './cordis.yml'
const configPath = resolveConfigPath(requested, undefined)
if (!existsSync(configPath)) {
  process.stderr.write(`usage: node launcher.mjs <path/to/cordis.yml>\n`)
  process.exit(1)
}

// boot 挂载完整组合。stdin EOF 与 SIGTERM → dispose 根上下文 → 优雅退出
// （持久化 flush；否则外部 SIGKILL 会丢尾部事件）。
const ctx = await boot(NAME, configPath)
const disposeAndExit = () => { void ctx.fiber.dispose().then(() => process.exit(0)) }
process.stdin.on('end', disposeAndExit)
process.on('SIGTERM', disposeAndExit)
