// 职责：批复队列（P0 一等表面，§4）—— 聚合项目内所有 Waiting（plan/permission/acceptance/cost），
// 每张显示"要什么 + 为什么 + 卡了多久"，决策（批准/拒绝）必须带评论送达 agent。
import { useEffect, useState } from 'react';
import { Icon } from '../components/icons';
import { listApprovals, decideApproval, type ApprovalItem } from '../api/client';
import { Markdown } from '../components/Markdown';

const KIND_LABEL: Record<string, string> = {
  plan: '计划确认',
  permission: '权限请求',
  acceptance: '验收',
  cost: '成本预算',
};

const KIND_ICON: Record<string, string> = { plan: 'doc', permission: 'lock', acceptance: 'check', cost: 'warn' };

export function ApprovalsView({ pid }: { pid: string }) {
  const [items, setItems] = useState<ApprovalItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [comments, setComments] = useState<Record<number, string>>({});

  const load = async () => {
    setLoading(true);
    try {
      setItems(await listApprovals(pid));
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [pid]);

  const decide = async (id: number, outcome: 'approved' | 'rejected') => {
    const ok = await decideApproval(id, outcome, comments[id] ?? '');
    if (ok) await load();
  };

  return (
    <div id="apprview">
      <div className="panel">
        <h2>批复队列 <span className="muted">Waiting · 一等表面（§4）</span></h2>
        {loading && items.length === 0 && <p className="muted">加载中…</p>}
        {!loading && items.length === 0 && (
          <p className="muted">队列为空 · 任务停在 Waiting 时出现在这里（含等待原因）</p>
        )}
        {items.map((a) => (
          <div key={a.id} className="approval">
            <div className="appr-head">
              <Icon name={KIND_ICON[a.kind] as 'lock' | 'check' | 'warn' | 'doc'} size="sm" />
              <strong>{KIND_LABEL[a.kind] ?? a.kind}</strong>
              <span className="muted">#{a.id} · {a.task_title ?? a.execution_id.slice(0, 8)}</span>
            </div>
            <div className="appr-reason">{a.reason || '（无原因说明）'}</div>
            <div className="appr-payload">
              {Object.entries(a.payload).map(([k, v]) => {
                if (k === 'plan' && typeof v === 'string' && v.length > 40) {
                  return (
                    <details key={k} className="appr-plan" open>
                      <summary>📋 计划内容</summary>
                      <div className="appr-plan-body"><Markdown text={v} /></div>
                    </details>
                  );
                }
                return <span key={k} className="tag">{k}: {String(v).slice(0, 60)}</span>;
              })}
            </div>
            <div className="appr-actions">
              <input
                className="appr-comment"
                placeholder="批复评论（送达 agent）"
                value={comments[a.id] ?? ''}
                onChange={(e) => setComments((c) => ({ ...c, [a.id]: e.target.value }))}
              />
              <button className="btn primary" onClick={() => void decide(a.id, 'approved')}>✅ 批准</button>
              <button className="btn" onClick={() => void decide(a.id, 'rejected')}>✋ 拒绝</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
