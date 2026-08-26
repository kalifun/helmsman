/**
 * 对照实验（M4 §5.2 / design-decisions §6C 实验 A）：
 * 同一任务集双跑 —— A 组带装配（KB 简报）、B 组裸跑（只有任务定义），
 * 对比**验收通过率**（独立验证器，不信任 agent 自评）/ 回合数 / 成本。
 * 顺序：先规则检索跑基线 → 再上向量（§5.2）。
 */
import type { MetricRow } from './storage.ts'

export interface ExperimentTask {
  title: string
  description: string
  /** 验收命令（可判定断言；退出码 0 = 通过）——任务完成后的独立验证 */
  acceptance?: string
}

export interface ExperimentRunRequest {
  project_id: string
  /** 任务集：两组共用（同任务双跑是实验成立的根基） */
  tasks: ExperimentTask[]
  /** 是否带装配（true = A 组，false = B 组） */
  brief: boolean
  /** 实验名（多次运行区分） */
  name?: string
}

export interface GroupCompare {
  group: string
  name: string
  total: number
  done: number
  failed: number
  /** 正常结束率（Done / total）——"agent 说做完了" */
  successRate: number
  /** 验收通过率（verified=true / 有验收的任务数）——"真的做对了" */
  verifyRate: number
  /** 有验收标准的任务数（verifyRate 的分母） */
  verifiedTasks: number
  avgTurns: number
  avgSteps: number
  avgCost: number
  briefHitRate: number // 简报命中率：brief_snapshot 非空的占比
  avgBriefEntries: number
  /** 输入成本拆分（缓存杠杆可见性，§6E）：全价输入 vs 缓存输入（1/50 价） */
  avgInputCost: number
  avgCacheCost: number
  avgOutputCost: number
  avgCacheTokens: number
}

/** 聚合一组 metrics → 对比行。 */
export function compareGroup(rows: MetricRow[], group: string, name: string): GroupCompare {
  const total = rows.length
  const done = rows.filter((r) => r.outcome === 'Done').length
  const failed = rows.filter((r) => r.outcome === 'Failed').length
  const avg = (fn: (r: MetricRow) => number): number =>
    total === 0 ? 0 : rows.reduce((s, r) => s + fn(r), 0) / total
  const withBrief = rows.filter((r) => r.brief_snapshot.length > 0)
  // 验收：只有 verified 明确 true/false 的任务算（无验收标准的任务不进分母）
  const verifiedRows = rows.filter((r) => r.verified !== undefined)
  const verifiedOk = verifiedRows.filter((r) => r.verified === true).length
  // 输入成本拆分（§6E）：input 全价 2元/M，cache 0.2元/M，输出/推理 8元/M
  const inputCost = (r: MetricRow): number => (r.in_tokens / 1e6) * 2.0
  const cacheCost = (r: MetricRow): number => (r.cache_tokens / 1e6) * 0.2
  const outputCost = (r: MetricRow): number =>
    (r.out_tokens / 1e6) * 8.0 + (r.reason_tokens / 1e6) * 8.0
  return {
    group,
    name,
    total,
    done,
    failed,
    successRate: total === 0 ? 0 : done / total,
    verifyRate: verifiedRows.length === 0 ? 0 : verifiedOk / verifiedRows.length,
    verifiedTasks: verifiedRows.length,
    avgTurns: Math.round(avg((r) => r.turns) * 100) / 100,
    avgSteps: Math.round(avg((r) => r.steps) * 100) / 100,
    avgCost: Math.round(avg((r) => r.cost) * 10000) / 10000,
    briefHitRate: total === 0 ? 0 : withBrief.length / total,
    avgBriefEntries: Math.round(avg((r) => r.brief_snapshot.length) * 100) / 100,
    avgInputCost: Math.round(avg(inputCost) * 100000) / 100000,
    avgCacheCost: Math.round(avg(cacheCost) * 100000) / 100000,
    avgOutputCost: Math.round(avg(outputCost) * 100000) / 100000,
    avgCacheTokens: Math.round(avg((r) => r.cache_tokens)),
  }
}

/** 生成对比报告（A vs B + 增益）。 */
export function compareReport(
  aRows: MetricRow[],
  bRows: MetricRow[],
  nameA = 'A 带装配',
  nameB = 'B 裸跑',
): {
  groups: [GroupCompare, GroupCompare]
  delta: { successRate: number; verifyRate: number; avgTurns: number; avgCost: number; briefHitRate: number; avgSteps: number }
  verdict: string
} {
  const a = compareGroup(aRows, 'A', nameA)
  const b = compareGroup(bRows, 'B', nameB)
  const delta = {
    successRate: Math.round((a.successRate - b.successRate) * 1000) / 1000,
    verifyRate: Math.round((a.verifyRate - b.verifyRate) * 1000) / 1000,
    avgTurns: Math.round((a.avgTurns - b.avgTurns) * 100) / 100,
    avgCost: Math.round((a.avgCost - b.avgCost) * 10000) / 10000,
    briefHitRate: Math.round((a.briefHitRate - b.briefHitRate) * 1000) / 1000,
    avgSteps: Math.round((a.avgSteps - b.avgSteps) * 100) / 100,
  }
  let verdict: string
  const hasVerify = a.verifiedTasks > 0 || b.verifiedTasks > 0
  if (a.total === 0 || b.total === 0) {
    verdict = '数据不足：至少一组无样本，等待任务完成'
  } else if (hasVerify && (a.verifyRate > b.verifyRate || (a.verifyRate === b.verifyRate && a.verifyRate > 0))) {
    if (a.verifyRate > b.verifyRate) {
      verdict = `验收通过率 带装配 ${(a.verifyRate * 100).toFixed(0)}% > 裸跑 ${(b.verifyRate * 100).toFixed(0)}%，装配可能有效（验收样本 ${a.verifiedTasks + b.verifiedTasks}，需扩大验证）`
    } else {
      // 验收持平 → 看开销
      const savedSteps = a.avgSteps < b.avgSteps ? `步骤 -${((1 - a.avgSteps / b.avgSteps) * 100).toFixed(0)}%` : '步骤持平'
      const savedCost = a.avgCost < b.avgCost ? `成本 -${((1 - a.avgCost / b.avgCost) * 100).toFixed(0)}%` : '成本持平'
      verdict = `验收通过率持平（${(a.verifyRate * 100).toFixed(0)}%），带装配 ${savedSteps}、${savedCost}（验收样本 ${a.verifiedTasks + b.verifiedTasks}）`
    }
  } else if (a.successRate > b.successRate) {
    verdict = `正常结束率 带装配 ${(a.successRate * 100).toFixed(0)}% > 裸跑 ${(b.successRate * 100).toFixed(0)}%（无验收标准，只能看结束率，建议任务集加 acceptance）`
  } else if (a.successRate === b.successRate && (a.avgSteps < b.avgSteps || a.avgCost < b.avgCost)) {
    const savedSteps = a.avgSteps < b.avgSteps ? `步骤 -${((1 - a.avgSteps / b.avgSteps) * 100).toFixed(0)}%` : '步骤持平'
    const savedCost = a.avgCost < b.avgCost ? `成本 -${((1 - a.avgCost / b.avgCost) * 100).toFixed(0)}%` : '成本持平'
    verdict = `结束率持平（${(a.successRate * 100).toFixed(0)}%），带装配 ${savedSteps}、${savedCost}（样本 ${a.total + b.total}；无验收标准，建议加 acceptance）`
  } else {
    verdict = `暂未观察到装配优势（结束率 ${a.successRate} vs ${b.successRate}，回合 ${a.avgTurns} vs ${b.avgTurns}），需检查检索命中或扩大样本`
  }
  return { groups: [a, b], delta, verdict }
}
