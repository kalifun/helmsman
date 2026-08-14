# dsh 引擎组合

helmsman 的引擎层：一个被 spawn 的 dsh（Node）子进程。控制走 ACP（stdin/stdout），观察走 JSONL 会话日志（`.sessions/`）。

## 组合（cordis.yml）

粒度 spine（参照 dsh 的 headless-agent 组合）+ ACP 控制通道：

- **不引入 session-query**：架构决策（architecture-v1.md §2.1），观察 = JSONL 日志 tail，派生索引我们自己做（Rust 侧 SQLite）。
- **不依赖 acp-demo bundle**：它无条件挂载 SessionQuerySqlite（需额外 DB），且是演示组合。
- 每任务一个 agent：`agent-spine` 的 `agents: []`，ACP `session/new` 按需创建。
- 模型：`deepseek-v4-flash`（P0 默认，分层策略见规格 §6）。

## 依赖来源

`~/.dsh/source/current`（每次拉分支后编译好的安装）。`dsh/node_modules` 是符号链接农场（dsh 自己的 `$DSH_HOME/profiles/node_modules` 同款模式），由以下命令重建：

```sh
# 从当前 cordis.yml 的裸插件名重建 package.json 依赖 + 符号链接
python3 - <<'PY'
import re, subprocess, os, json
D = os.path.expanduser('~/.dsh/source/current')
s = open('cordis.yml').read()
names = sorted(set(re.findall(r"name: '(@deepseek-ai/[^']+)'", s))) + ['@deepseek-ai/dsh-app-boot']
deps = {}
for n in sorted(set(names)):
    out = subprocess.run(['grep','-rl',f'"name": "{n}"','--include=package.json','packages'],
                         cwd=D, capture_output=True, text=True).stdout.split()
    if out:
        deps[n] = f"file:{D}/{os.path.dirname(out[0])}"
json.dump({"name":"helmsman-dsh","private":True,"type":"module","dependencies":deps},
          open('package.json','w'), indent=2, ensure_ascii=False)
for n, spec in deps.items():
    t = os.path.normpath(os.path.join('node_modules', n))
    os.makedirs(os.path.dirname(t), exist_ok=True)
    if os.path.lexists(t): os.remove(t)
    os.symlink(os.path.normpath(spec.replace('file:','')), t)
PY
# tsx（loader 需要 tsx 解析 config-relative 裸包名，dsh 自身也是 node --import tsx/esm 启动）
ln -sfn ~/.dsh/source/current/node_modules/tsx node_modules/tsx
```

## 运行（重要：cwd 必须是 dsh checkout 根）

Loader 按 tsconfig `paths` 解析裸插件名，tsx 按 **cwd** 找 tsconfig ——
所以**必须从 dsh checkout 根启动**（`pnpm dsh` 源码启动同款；当前默认
`~/Code/github/opensource/test-kalifun`，可用 `HELMSMAN_DSH_ROOT` 覆盖）。
路径用绝对路径，持久化/工作区用环境变量指定（避免写进 checkout）：

```sh
DSH_ROOT=~/Code/github/opensource/test-kalifun
cd $DSH_ROOT
mkdir -p $PWD/../helmsman-sessions   # 会话落在仓库外？见下

HELMSMAN_SESSIONS_ROOT=~/.dsh/source/current/.sessions \
HELMSMAN_WORKSPACE=~                       \
node --import tsx/esm /path/to/helmsman/dsh/launcher.mjs /path/to/helmsman/dsh/cordis.yml
# 保持运行：stdin/stdout 即 ACP 通道（Rust 产品服务将 spawn 它，见 crates/spawn）
```

Rust `spawn` 模块已经按此形态实现（cwd=安装根 + 绝对路径 + HELMSMAN_* 环境变量）。

## 注意事项

- **改 compression 配置后必须清 `.sessions/`**：后端会检测旧产物格式
  （`.jsonl.zstd` vs `.jsonl`），格式不匹配直接拒载。
