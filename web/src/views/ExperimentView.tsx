// 职责：对照实验面板（§6C 实验 A）——同一任务集双跑（A 带装配 vs B 裸跑），
// 对比成功率 / 回合数 / 成本 / 简报命中率，回答"装配到底有没有用"。
import { useEffect, useState } from 'react';
import { Icon } from '../components/icons';

interface GroupCompare {
  group: string;
  name: string;
  total: number;
  done: number;
  failed: number;
  successRate: number;
  avgTurns: number;
  avgSteps: number;
  avgCost: number;
  avgCacheCost: number;
  briefHitRate: number;
  avgBriefEntries: number;
  verifyRate: number;
  verifiedTasks: number;
}

interface CompareReport {
  groups: [GroupCompare, GroupCompare];
  delta: { successRate: number; verifyRate: number; avgTurns: number; avgCost: number; briefHitRate: number; avgSteps: number };
  verdict: string;
}

const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;

export function ExperimentView({ pid }: { pid: string }) {
  const [report, setReport] = useState<CompareReport | null>(null);
  const [tasksText, setTasksText] = useState(
    'transfer.go 锁竞态修复方案：简述死锁根因和修复方向\n' +
    'transfer.go 加锁顺序问题：并发路径加锁顺序不一致会导致什么',
  );
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState('');

  const load = async () => {
    const r = await fetch(`/api/experiments/compare?project=${encodeURIComponent(pid)}`);
    setReport((await r.json()) as CompareReport);
  };

  useEffect(() => {
    void load();
  }, [pid]);

  const run = async (brief: boolean) => {
    setRunning(true);
    setMsg(brief ? 'A 组（带装配）已启动，任务逐个排队执行…' : 'B 组（裸跑）已启动，任务逐个排队执行…');
    try {
      const tasks = tasksText
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
          // 每行：标题：描述 || 验收命令（验收命令用 || 分隔，退出码 0 = 通过）
          const [taskPart, acceptance] = line.split('||').map((s) => s.trim());
          const [title, ...rest] = taskPart.split(/[：:]/);
          return {
            title: title.trim(),
            description: rest.join('：').trim(),
            ...(acceptance ? { acceptance } : {}),
          };
        });
      const r = await fetch('/api/experiments/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project_id: pid, brief, tasks, name: '对照实验' }),
      });
      if (!r.ok) throw new Error((await r.text()).slice(0, 200));
      const d = (await r.json()) as { group: string; created: unknown[] };
      setMsg(`✅ ${d.group} 组已创建 ${d.created.length} 个任务。任务完成后刷新对比结果。`);
      setTimeout(() => void load(), 2000);
    } catch (e) {
      setMsg(`❌ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div id="expview">
      <div className="panel">
        <h2>对照实验 <span className="muted">A 带装配 vs B 裸跑（§6C 实验 A）</span></h2>
        <div className="exp-setup">
          <textarea
            value={tasksText}
            onChange={(e) => setTasksText(e.target.value)}
            rows={4}
            placeholder={'每行一个任务：标题：描述 || 验收命令\n示例：生成 lock_order.txt：写入加锁建议 || test -s /tmp/x.txt\n（验收命令退出码 0 = 通过；两组共用同一任务集）'}
          />
          <div className="exp-actions">
            <button className="btn primary" disabled={running} onClick={() => void run(true)}>
              <Icon name="play" size="sm" /> 跑 A 组（带装配）
            </button>
            <button className="btn" disabled={running} onClick={() => void run(false)}>
              <Icon name="play" size="sm" /> 跑 B 组（裸跑）
            </button>
            <button className="btn" onClick={() => void load()}>刷新对比</button>
          </div>
          {msg && <p className="exp-msg">{msg}</p>}
        </div>

        {report && (
          <div className="exp-compare">
            <table className="exp-table">
              <thead>
                <tr>
                  <th>组</th>
                  <th>样本</th>
                  <th>结束率</th>
                  <th>验收通过率</th>
                  <th>平均回合</th>
                  <th>平均步骤</th>
                  <th>平均成本 ¥</th>
                  <th>缓存成本</th>
                  <th>简报命中</th>
                </tr>
              </thead>
              <tbody>
                {report.groups.map((g) => (
                  <tr key={g.group}>
                    <td><strong>{g.name}</strong></td>
                    <td>{g.total}</td>
                    <td>{pct(g.successRate)}</td>
                    <td title={`${g.verifiedTasks} 个带验收任务`}>
                      {g.verifiedTasks > 0 ? pct(g.verifyRate) : <span className="muted">无验收</span>}
                    </td>
                    <td>{g.avgTurns}</td>
                    <td>{g.avgSteps}</td>
                    <td>{g.avgCost.toFixed(4)}</td>
                    <td title="缓存命中杠杆（装配稳定前缀 → KV 缓存读）">{g.avgCacheCost.toFixed(4)}</td>
                    <td>{pct(g.briefHitRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="exp-delta">
              <div>Δ 结束率：<strong>{report.delta.successRate > 0 ? '+' : ''}{pct(report.delta.successRate)}</strong></div>
              <div>Δ 验收通过率：<strong>{report.delta.verifyRate > 0 ? '+' : ''}{pct(report.delta.verifyRate)}</strong></div>
              <div>Δ 简报命中：<strong>{report.delta.briefHitRate > 0 ? '+' : ''}{pct(report.delta.briefHitRate)}</strong></div>
              <div>Δ 回合：<strong>{report.delta.avgTurns > 0 ? '+' : ''}{report.delta.avgTurns}</strong></div>
              <div>Δ 步骤：<strong>{report.delta.avgSteps > 0 ? '+' : ''}{report.delta.avgSteps}</strong></div>
              <div>Δ 成本：<strong>{report.delta.avgCost > 0 ? '+' : ''}{report.delta.avgCost.toFixed(4)}</strong></div>
            </div>
            <p className="verdict">📋 {report.verdict}</p>
          </div>
        )}
      </div>
    </div>
  );
}
