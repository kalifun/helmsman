# Helmsman 给 Agent 的环境约定

本仓库的工具链由 **Nix flake + direnv（nix-direnv）** 管理，不是 nvm / Homebrew / 全局 Node。

## 先加载环境，再判断缺不缺

Agent 的非交互 shell **不会**跑 zsh 的 `direnv hook`，所以裸跑 `which node` / `which pnpm` 经常是空的。这不代表本机没装，更不要去：

- 用 nvm / fnm / volta 装 Node
- 用 Homebrew / apt 装 Node
- 拿 Cursor / Zed 自带的 Node 或 `corepack` 顶替
- 改用户的 `~/.zshrc` / nix config

正确做法是先加载本仓库的 direnv，再执行命令：

```bash
# 单次命令（推荐）
direnv exec . <command>

# 当前 shell 注入 PATH（后续命令都走 Nix 环境）
eval "$(direnv export bash)"
```

加载成功后应能看到类似：

- `node` → Nix 的 Node.js 22（当前 22.23.2）
- `pnpm` → Nix 的 pnpm（当前 11.20.0）

若 `direnv exec .` 失败：先在仓库根执行 `direnv allow`，不要自行安装工具链。

## 本机文件（不要提交、不要删除）

这些是开发者本机环境，已在 `.gitignore`：

| 路径 | 作用 |
|---|---|
| `.envrc` | `use flake .`（direnv 入口） |
| `.direnv/` | nix-direnv 缓存的 devShell |
| `flake.nix` / `flake.lock` | 本机 flake（若在） |

仓库里看不到 `flake.nix` 也正常：环境在本机，不进 git。

## 日常命令

都从仓库根、经 direnv 跑：

```bash
direnv exec . bash -lc 'cd dsh && pnpm install'
direnv exec . bash -lc 'cd server-ts && pnpm test'
direnv exec . bash -lc 'cd web && pnpm dev'
```
