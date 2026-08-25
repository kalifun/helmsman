// 职责：批复队列（P0 一等表面，§4）—— 聚合项目内所有 Waiting（plan/permission/acceptance/cost），
// 每张卡（ApprovalCard，Beautiful UI 移植）呈现"要什么 + 为什么 + 卡了多久"，
// 决策（批准/拒绝）必须带评论送达 agent；策略建议一键采用（仅本次，不静默）。
import { useEffect, useState } from 'react';
import { useUi } from '../store/ui';
import { listApprovals, decideApproval, listPolicies, deletePolicy, listSuspendedApprovals, resumeApproval, resumeAllApprovals, type ApprovalItem, type PolicyRow } from '../api/client';
import { ApprovalCard, KIND_LABEL } from '../components/ApprovalCard';
import { LoadingState } from '../components/LoadingState';

export function ApprovalsView({ pid }: { pid: string }) {
  const [items, setItems] = useState<ApprovalItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [policies, setPolicies] = useState<PolicyRow[]>([]);
  const [showPolicies, setShowPolicies] = useState(false);
  const [suspended, setSuspended] = useState<ApprovalItem[]>([]);

  const load = async () => {
    setLoading(true);
    try {
      setItems(await listApprovals(pid));
      setPolicies(await listPolicies(pid));
      setSuspended(await listSuspendedApprovals(pid));
    } catch {
      setItems([]);
      setPolicies([]);
      setSuspended([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [pid]);

  const toast = useUi((s) => s.toast);
  const decide = async (id: number, outcome: 'approved' | 'rejected', comment: string, remember: boolean) => {
    try {
      const ok = await decideApproval(id, outcome, comment, remember);
      if (ok) await load();
    } catch (e) {
      toast(`决策失败：${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
    }
  };

  return (
    <div id="apprview">
      <div className="panel">
        <h2>
          批复队列 <span className="muted">Waiting · 一等表面（§4）</span>
          <button className="policy-toggle" onClick={() => setShowPolicies((v) => !v)}>
            🧠 策略规则 {policies.length ? `(${policies.length})` : ''}
          </button>
        </h2>
        {showPolicies && (
          <div className="policy-panel">
            {policies.length === 0 && <div className="muted" style={{ padding: '6px 0' }}>暂无策略 —— 批复时勾选「记住这个选择」会沉淀策略原子，同类批复 count≥2 后给出建议。</div>}
            {policies.map((p) => (
              <div key={p.id} className="policy-row">
                <span className="tag">{p.kind}</span>
                <span className="tag">{p.scope}</span>
                <span className={'policy-outcome ' + p.outcome}>{p.outcome === 'approved' ? '批准' : '拒绝'} ×{p.count}</span>
                <span className="muted" style={{ fontSize: 10.5, fontFamily: 'var(--mono)' }}>{new Date(p.updated_at).toLocaleString()}</span>
                <button className="btn mini ghost" onClick={async () => { if (await deletePolicy(p.id)) void load(); }}>删除</button>
              </div>
            ))}
          </div>
        )}
        {suspended.length > 0 ? (
          <div className="suspend-panel">
            <div className="suspend-head">
              <span>⏸ 挂起 {suspended.length} 项（Waiting 超时 30 分钟自动挂起 · 非失败）</span>
              <button className="btn mini ghost" onClick={async () => { if (await resumeAllApprovals(pid)) void load(); }}>全部恢复</button>
            </div>
            {suspended.map((a) => (
              <div key={a.id} className="suspend-row">
                <span className="tag">{KIND_LABEL[a.kind] ?? a.kind}</span>
                <span className="suspend-title">{a.task_title}</span>
                <span className="muted" style={{ fontSize: 10.5, fontFamily: 'var(--mono)' }}>#{a.id}</span>
                <button className="btn mini" onClick={async () => { if (await resumeApproval(a.id)) void load(); }}>恢复</button>
              </div>
            ))}
          </div>
        ) : null}
        {loading && items.length === 0 && <LoadingState variant="orbit" label="加载批复…" />}
        {!loading && items.length === 0 && (
          <p className="muted">现在没有要批的事项。任务停下等人时会出现在这里。</p>
        )}
        {items.map((a) => (
          <ApprovalCard
            key={a.id}
            item={a}
            onDecide={(outcome, comment, remember) => void decide(a.id, outcome, comment, remember)}
          />
        ))}
      </div>
    </div>
  );
}
