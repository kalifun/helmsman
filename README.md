# 🐳 Helmsman

<p align="center">
  <img src="images/helmsman-wordmark.svg" width="360" alt="Helmsman" />
</p>

> **给个人开发者的任务式 AI 工作台** —— 以项目为隔离单位，以任务为执行单元，
> 以评论为控制通道，以项目知识库为持久记忆。你掌舵（Helm），agent 划船。

Helmsman 是一个本地优先、自托管的编码代理工作台：把"和 agent 聊天"变成"管理任务"。
每个任务是一个独立的会话，跑完自动沉淀结论到项目知识库，下一个任务自动装配相关知识 ——
**上下文不丢，重复劳动不再发生**。

## ✨ 亮点

- **任务即会话**：建卡即自动执行，看板管理，1 卡可多轮执行（fork 派生新代次）
- **评论即控制**：不弹窗打断，所有指示/批复走评论流 + 批复队列（一等表面）
- **Waiting 状态机**：计划待批 / 权限请求 / 验收门 / 成本预算 —— 任务卡住时明确"为什么、要什么"
- **预设 Profile**：三轴组合（协作方式 × 执行设定 × 审批姿态 × 沙箱）收敛为命名预设，
  建卡选一个；计划模式自动产出计划等你批准，交付设定强制验收门
- **项目知识库**：任务完成自动沉淀（带具体性门槛，泛化总结不进库），双时态 + 信任分级
- **上下文装配**：新任务自动带上前人结论（前缀分区 → KV 缓存命中，成本更低）
- **对照实验**：同任务集"带装配 vs 裸跑"双跑，用验收通过率/成本数据回答"装配到底有没有用"

## 🚀 快速开始

### 前置

- Node.js ≥ 22
- `DEEPSEEK_API_KEY`（引擎调用 DeepSeek）

### 启动

```bash
# 1. 引擎依赖（dsh/）—— 含 ACP 补丁（每任务预设透传）
cd dsh && pnpm install && pnpm patch

# 2. 产品服务（server-ts/）
cd server-ts && pnpm install && pnpm start     # → http://127.0.0.1:3081

# 3. 前端（web/）
cd web && pnpm install && pnpm dev             # → http://127.0.0.1:5173
```

浏览器打开 http://127.0.0.1:5173 → 注册项目目录 → 建卡 → 看板/批复/知识库。

### 测试

```bash
cd server-ts && pnpm test    # 136 个 vitest 用例
```

## 🏗 技术栈

| 层 | 技术 |
|---|---|
| 产品服务 | TypeScript · Node · better-sqlite3（单文件 SQLite）|
| 引擎 | [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh，Node 子进程，ACP 控制 + JSONL 观察）|
| 前端 | React 18 · Vite · zustand |
| 测试 | vitest |

## 📁 布局

```
server-ts/   TS 产品服务（HTTP/WS + 投影 + 批复队列 + 知识库 + 装配 + 实验）
dsh/         dsh 引擎组合（cordis.yml + agent-presets + ACP 补丁）
web/         React 前端
```

## 🗺 路线图

- [x] P0：资产卡 / 批复队列 / 会话钻入 / 知识库装配 / 预设三轴 / 对照实验
- [x] P1·需求校准流程（AI 提案验收标准，批准写回卡验收标准）
- [x] P1·目标模式（goal mode + checkpoint 阶段确认）
- [x] P1·Yolo（审批轴全放手，跳过检查点）
- [x] P1·策略学习·批复沉淀（记住勾选 → 策略原子 → count≥2 给建议 → 一键采用）
- [x] P1·序列任务曲线（度量页按执行时序 + 对照实验 A/B 分组）
- [x] P1·沉淀提炼 Agent（distill 预设 + 独立 ACP 会话，主对话零污染；规则版兜底）
- [x] P1·策略学习·命令级白名单（rm/sudo/git push 精确匹配 → 批复队列决策，拒绝幂等走策略沉淀；yolo 轴跳过）
- [x] P2·向量检索（bge-small-zh 本地 embedding，混合检索：规则 + 语义通道）
- [x] P2·知识演化（沉淀前防重复 + 库内自动合并 + 毒化检测）
- [x] P2·文件内容预览（读取接口 + 语法高亮 + Markdown 渲染）
- [x] P2·设置热更新（检索阈值 / 装配条数，storage 持久化无需重启）
- [x] P2·首页真实化（源码管理面板 / 最近沉淀 / 待批复 / git 状态）
- [x] P2·并发互斥（git worktree 隔离 + 同时任务上限，根治共享工作区写冲突；原"写冲突检测"条目由本项取代）
- [ ] P2·桌面壳（Tauri v2 sidecar —— 分发层，排在核心闭环稳定 + 命令级白名单之后；触发信号：觉得"终端两条命令 + 浏览器"烦了、或要让不熟悉 dsh 的人用）

> 状态核对基准：2026-08 按代码核实（README 复选框为快照，接口/服务演进以仓库为准）。

## 📄 许可

MIT（dsh 引擎为 MIT，见 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)）
