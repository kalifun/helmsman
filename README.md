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
cd server-ts && pnpm test    # 44 个 vitest 用例
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
- [ ] P1：需求校准流程（AI 提案验收标准）/ 目标模式 / Yolo / 策略学习（批复+白名单）/ 序列任务曲线
- [ ] P2：向量检索（本地 embedding）/ 知识演化 / 桌面壳（Tauri）

## 📄 许可

MIT（dsh 引擎为 MIT，见 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)）
