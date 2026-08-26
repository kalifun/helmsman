# 保序去重 CLI（dedupe）设计说明

> 用 Node 零依赖实现保序去重 CLI 的设计说明。
> 基线：项目知识库「Yolo验证-去重CLI」已有零依赖原型 `dedupe.mjs`（~30 行）并经 5 用例验证通过，
> 本设计在其基础上规范化（补充 stdin、`--help`、错误分类、CLI 契约与验收用例），核心算法保持一致。

## 1. 背景与目标

- **背景**：需要一个把文件/管道中的重复行去掉、同时保持各行首次出现顺序的小工具（日志去重、配置合并、清单清洗等场景）。
- **目标**：用 Node 实现、**零第三方依赖**（仅 Node 内置模块）的保序去重 CLI。
- **保序语义**：重复行只保留**首次出现**的那一次，输出顺序 = 各行首次出现的顺序（非字典序、非末次出现）。
- **交付形态**：单文件 ESM 脚本 `dedupe.mjs`，`node dedupe.mjs` 直接运行，无安装、无构建。

## 2. 需求

### 2.1 功能需求

| 编号 | 需求 | 说明 |
|---|---|---|
| F1 | 文件去重 | `node dedupe.mjs <文件>` 按行读取，保序去重后输出到 stdout |
| F2 | 管道输入 | `cat in.txt \| node dedupe.mjs`（参数为 `-` 或省略）从 stdin 读取 |
| F3 | CRLF 兼容 | `\r\n` 与 `\n` 都按行切分，`\r` 不作为行内容，输出统一 LF |
| F4 | 空行参与去重 | 空行也是「行」：重复空行只保留首个 |
| F5 | 空输入 | 空文件 / 空 stdin → 无输出，退出码 0 |
| F6 | 文件错误 | 文件不存在 / 不可读 → stderr 报错，退出码 1 |
| F7 | 用法提示 | `--help` / `-h` 打印用法并退出 0；参数非法打印用法并退出 1 |
| F8 | 内容即身份 | 行按内容**原样**比较：区分大小写、保留行首尾空格、保留 Unicode/UTF-8 原样 |

### 2.2 非功能需求

- **零依赖**：只用 `node:fs`、`node:process` 等内置模块，无 package.json 依赖、无 lockfile。
- **确定性**：相同输入必得相同输出（Set 判重与遍历顺序均确定）。
- **简单优先**：全量读入内存（`readFileSync`）换取实现简单；大文件流式方案见 §4.4 留作扩展，不进 v1。

## 3. 总体设计

```
                        ┌─────────────────────────────┐
   argv[2] ──┬─ <文件> ─▶│  readInput(arg)             │
             │           │   - 文件: fs.readFileSync   │
   stdin ────┴─ - / 缺省▶│   - stdin: fs.readFileSync(0)│
                        └──────────────┬──────────────┘
                                       ▼
                        ┌─────────────────────────────┐
                        │  dedupeLines(text)          │  ← 纯函数
                        │   归一 CRLF → split → Set   │
                        │   判重 → 保序行数组           │
                        └──────────────┬──────────────┘
                                       ▼
                        ┌─────────────────────────────┐
                        │  stdout: join('\n') + '\n'   │
                        │  stderr: 错误信息 + exit 1    │
                        └─────────────────────────────┘
```

- 单文件 `dedupe.mjs`，三部分职责：**参数解析与错误处理**（`main`）、**输入读取**（`readInput`）、**纯去重逻辑**（`dedupeLines`）。
- 去重核心与已验证原型一致：`Set` 记录已见行，遍历时未见则入 `Set` 并追加到结果数组 → 天然保序。

## 4. 详细设计

### 4.1 函数划分

```
main(argv)            // 入口：解析参数、调用 readInput/dedupeLines、写 stdout、设退出码
readInput(arg)        // arg === '-' 或 undefined → stdin；否则读文件（ENOENT/EACCES 上抛）
dedupeLines(text)     // 纯函数：(string) => string[]，保序去重后的行数组
```

### 4.2 核心算法（dedupeLines）

```js
function dedupeLines(text) {
  const lines = text.replaceAll('\r\n', '\n').split('\n')
  const seen = new Set()
  const out = []
  for (const line of lines) {
    if (!seen.has(line)) { seen.add(line); out.push(line) }
  }
  return out
}
```

- **CRLF 归一在前**：先 `replaceAll('\r\n', '\n')` 再 `split('\n')`，避免行尾残留 `\r`，且兼容「文件最后一行无换行符」（split 仍产出该行）。
- **判重粒度 = 整行原文**：空串、含空格行、中文字符均按原样参与比较。
- **保序**：输出数组顺序即遍历顺序 = 各行首次出现顺序。

### 4.3 CLI 契约

```
用法:
  node dedupe.mjs <文件>         # 文件保序去重
  cat in.txt | node dedupe.mjs  # stdin 保序去重（参数省略或为 -）
  node dedupe.mjs --help        # 打印用法，退出 0

退出码:
  0  成功（含空输入 → 无输出）
  1  文件不存在 / 不可读 / 参数非法
```

- 输出：非空结果 = `join('\n') + '\n'`（末尾补一个换行）；空结果 = 无任何输出。
- 错误信息写 stderr，格式：`dedupe: <原因>`（如 `dedupe: ENOENT: no such file or directory, open 'x.txt'`）。

### 4.4 边界与取舍

| 场景 | 行为 |
|---|---|
| 空文件（0 字节） | 无输出，退出 0 |
| 仅含换行 / 空行重复 | 空行参与去重，重复空行只留首个 |
| CRLF 文件 | 行内容不含 `\r`，输出统一 LF |
| 末行无换行 | 正常参与去重，输出时补末尾换行 |
| 行含首尾空格 / 大小写差异 | 原样比较，`a` 与 `A`、`"a"` 与 `" a "` 视为不同行 |
| 中文 / emoji / 任意 UTF-8 | `readFileSync(utf8)` 原样读写，不做转码 |
| 大文件 | v1 全量读入内存（简单优先）；扩展：`readline` 逐行 + 增量 Set，接口不变 |
| 权限拒绝 / 路径为目录 | 捕获 EACCES 等错误 → stderr + 退出 1 |

## 5. 验收计划

### 5.1 基线用例（对应知识库已验证通过的 5 用例）

| # | 用例 | 期望 |
|---|---|---|
| ① | 基本去重 `apple/banana/apple/cherry/banana` | `apple/banana/cherry` |
| ② | 重复空行 | 只保留首个空行 |
| ③ | CRLF 换行 | 按行正确，输出无 `\r` |
| ④ | 空文件 | 无输出，退出码 0 |
| ⑤ | 文件不存在 | stderr 报错，退出码 1 |

### 5.2 新增用例（本设计扩展）

| # | 用例 | 期望 |
|---|---|---|
| ⑥ | stdin：`printf 'a\nb\na\n' \| node dedupe.mjs` | 输出 `a\nb` |
| ⑦ | `node dedupe.mjs -`（显式 `-`） | 同 ⑥ |
| ⑧ | `node dedupe.mjs --help` | 打印用法，退出码 0 |
| ⑨ | 末行无换行：`printf 'x\ny\nx'` | 输出 `x\ny`（末尾补换行） |
| ⑩ | 大小写/空格敏感：`a`、`A`、` a` | 三行都保留 |

### 5.3 验收命令

```bash
# 用例①
printf 'apple\nbanana\napple\ncherry\nbanana\n' > /tmp/dedupe-in.txt
node dedupe.mjs /tmp/dedupe-in.txt   # 期望: apple banana cherry（各一行）
# 用例④
: > /tmp/dedupe-empty.txt && node dedupe.mjs /tmp/dedupe-empty.txt && echo "exit=$?"  # exit=0 且无输出
# 用例⑤
node dedupe.mjs /tmp/不存在.txt; echo "exit=$?"   # stderr 报错，exit=1
```

## 6. 参考

- 知识库「Yolo验证-去重CLI」：原型 `dedupe.mjs`（零依赖 Node ESM，~30 行，Set 保序去重）及其 5 用例验证记录。
- 知识库「校准验证-计算器」/「校准验证-待办CLI」：同风格零依赖 Node CLI 的既有实现范式（用法、退出码、错误处理约定）。
