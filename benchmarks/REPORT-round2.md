# CWL 结构化驱逐 — 实验报告（第 2 轮：真实压力对照）

> 日期：2026-09 | 范式：arXiv:2606.11213 | 自研：独立插件 `dsh-cwl`（Helmsman 以依赖消费）
> 第 1 轮结论（短任务硬压驱逐有害）→ 方法论修正：**多轮对话真实压力** + 分级驱逐

## 方法论修正（关键）

第 1 轮用"低预算硬压 5 步短任务"测驱逐，结论是"驱逐有害"——**这是错的测法**。
修正后：
1. **真实压力场景**：同一会话连续 12 轮对话，上下文自然累积到 200K+ cacheRead tokens
2. **压力计量修复**：`tokenMeter.measure().totalTokens` 不含 cacheRead（缓存是长会话
   上下文主要占用）→ 改用 session usage 事件累计真实压力（input+cache+output+reason）
3. **分级驱逐**：对齐 pi-cwl graduated levels（expl 优先、被依赖 expl 保护、最新尾巴保护）

## 实验设置

- 场景：同一 chat 会话连续 12 轮，每轮"读 items.json + 按轮次写文件"
- CWL 预算：`HELMSMAN_CWL_BUDGET=30000`（上下文超 30K 触发驱逐）
- baseline：无驱逐（默认 80% 不触发）

## 结果（真实会话 usage，12 轮全部 Done）

| 指标 | baseline | CWL（驱逐 expl-1/expl-2/act-1）| Δ |
|---|---|---|---|
| turns | 12 | 12 | — |
| steps | 30 | 26 | **-13%** |
| inputTokens | 28,478 | **10,343** | **-64%** |
| cacheReadTokens | 200,576 | 178,432 | **-11%** |
| outputTokens | 2,809 | 2,107 | **-25%** |
| reasoningTokens | 128 | 126 | — |

## 结论

**CWL 在真实长会话中有效（回答"啥时候管、怎么管"）**：
- **inputTokens -64%**：驱逐早期 expl 后，agent 不再每轮重复读大段内容 → 未命中输入大降
- **steps -13%、output -25%**：效率提升，12 轮质量不降（每轮价格计算正确）
- **驱逐 3 次未破坏任务**（对比第 1 轮 v1 驱逐 50 次拖垮任务）

**边界（诚实）**：
- cacheRead 仅 -11%：驱逐掉早期段，但每轮新增轮次内容占缓存大头，总压力降幅有限
- 收益集中在 input（未命中部分）→ 适合超长会话/低缓存命中场景

## 复现

```bash
# baseline（无驱逐）
node dsh/launcher.mjs dsh/cordis.yml
node benchmarks/run-context-pressure.mjs baseline 12
# CWL（预算 30000 触发驱逐）
HELMSMAN_CWL_BUDGET=30000 node dsh/launcher.mjs dsh/cordis.yml
node benchmarks/run-context-pressure.mjs cwl 12
```
