// [helmsman] 命令级白名单守卫（P1）—— tools/pre-execute 监听插件。
// 挂在 guard 预设内（agent scope）：每个 agent 的工具调用在调度前都会过这里。
// 职责：bash 命令的危险识别 + 白名单放行 + 危险命令转人工审批（ask）。
// 审批缝：返回 { kind: 'ask', reason } → dsh-tools serviceAsk → ctx.approval.request
//   → dsh-acp 桥 → ACP requestPermission → Helmsman 批复队列（Waiting{permission}）。
// 注意：本插件不落盘记忆（每 agent 会话独立）；"拒绝幂等/记住"由 Helmsman 侧策略沉淀承接。
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// 仅用 node 内置能力，避免依赖解析问题：预编译正则，纯函数匹配。

/** 危险命令识别（前缀/正则精确匹配）。返回 { risk, reason } 或 null（安全放行）。 */
const DANGER_PATTERNS = [
  // 最危险优先：rm -rf 根目录/家目录/当前目录（必须最先匹配，避免被通用 rm 规则吞掉）
  { re: /(^|\s)rm\s+-[a-zA-Z]*rf[a-zA-Z]*\s+(\/|~)(\s|$)/, risk: 'rm-root', label: 'rm -rf 根目录/家目录' },
  { re: /(^|\s)rm\s+-[a-zA-Z]*rf[a-zA-Z]*\s+(\.|\.\/)\s*$/, risk: 'rm-root', label: 'rm -rf 当前目录' },
  // 破坏性文件删除：rm -r/-rf 组合（仅删单文件的 rm -f 不危险）
  { re: /(^|\s)rm\s+-[a-zA-Z]*rf[a-zA-Z]*\s+/, risk: 'rm', label: 'rm 递归/强制删除' },
  { re: /(^|\s)rm\s+-[a-zA-Z]*r[a-zA-Z]*\s+/, risk: 'rm', label: 'rm 递归删除' },
  // sudo（越权）
  { re: /(^|\s)sudo\s+/, risk: 'sudo', label: 'sudo 提权命令' },
  // git 危险操作
  { re: /(^|\s)git\s+push(\s|$)/, risk: 'git-push', label: 'git push（推送远端）' },
  { re: /(^|\s)git\s+reset\s+--hard\s+/, risk: 'git-reset-hard', label: 'git reset --hard（丢弃改动）' },
  { re: /(^|\s)git\s+clean\s+(-[a-zA-Z]*f[a-zA-Z]*\s*)+/, risk: 'git-clean', label: 'git clean -f（删除未跟踪）' },
  { re: /(^|\s)git\s+checkout\s+--\s+/, risk: 'git-checkout-dot', label: 'git checkout --（丢弃工作区改动）' },
  { re: /(^|\s)git\s+branch\s+-D\s+/, risk: 'git-branch-D', label: 'git branch -D（强删分支）' },
  // 危险重定向/覆盖
  { re: /(^|\s)>\s*\/dev\/sd[a-z]/, risk: 'disk-write', label: '直接写磁盘设备' },
  { re: /(^|\s)mkfs\./, risk: 'mkfs', label: '格式化磁盘' },
  // 危险下载执行
  { re: /(^|\s)curl\s+.*\|\s*(sh|bash)\s*$/, risk: 'curl-pipe-sh', label: 'curl 管道执行 shell' },
  { re: /(^|\s)wget\s+.*\|\s*(sh|bash)\s*$/, risk: 'wget-pipe-sh', label: 'wget 管道执行 shell' },
  // 系统管理
  { re: /(^|\s)(shutdown|reboot|poweroff|halt)\s*$/, risk: 'sysctl', label: '关机/重启' },
  { re: /(^|\s)kill\s+-9\s+/, risk: 'kill-9', label: 'kill -9（强杀）' },
  { re: /(^|\s)chmod\s+777\s+/, risk: 'chmod-777', label: 'chmod 777' },
  { re: /(^|\s)chown\s+-R\s+/, risk: 'chown-R', label: 'chown -R（递归改属主）' },
]

/** 安全白名单：允许的危险命令精确形式（命令前缀匹配，防误伤正常操作）。 */
const ALLOW_PREFIXES = [
  'rm -rf /tmp/',      // 清自己的临时区
  'rm -rf ./dist',     // 清构建产物
  'rm -rf dist',       // 同上（无 ./）
  'rm -rf node_modules', // 重装依赖
  'rm -rf .pnpm-store',
]

/**
 * 匹配一条 bash 命令。
 * @param {string} command 完整命令（bash 工具的 command 参数）
 * @returns {{ risk: string, label: string } | null} 危险则返回描述，安全则 null
 */
export function matchDanger(command) {
  const trimmed = String(command ?? '').trim()
  if (!trimmed) return null
  // 白名单精确前缀：先放行，避免把允许的清构建/重装当危险
  for (const p of ALLOW_PREFIXES) {
    if (trimmed.startsWith(p)) return null
  }
  for (const d of DANGER_PATTERNS) {
    if (d.re.test(trimmed)) {
      return { risk: d.risk, label: d.label }
    }
  }
  return null
}

/** Cordis 插件名。 */
export const name = 'helmsman-command-guard'
/** 无需注入服务：pre-execute 是作用域 waterfall 事件，ctx.on 即可监听。 */
export const inject = []

/** 插件主体：监听 tools/pre-execute，危险 bash 命令 → ask（人工审批）。 */
export function apply(ctx) {
  ctx.on('tools/pre-execute', (exec, next) => {
    // 只审 bash 工具调用（其他工具如 fs 由沙箱管）
    if (exec?.name !== 'bash') return next()
    const command = exec.arguments?.command
    const hit = matchDanger(command)
    if (hit === null) return next()
    // 危险命令 → 转人工审批。reason 会原样送达 answerer（Helmsman 批复卡展示）。
    return {
      kind: 'ask',
      reason: `命令级白名单：检测到「${hit.label}」（风险 ${hit.risk}）。命令：${String(command).slice(0, 200)}`,
    }
  })
}

export default { name, inject, apply }
