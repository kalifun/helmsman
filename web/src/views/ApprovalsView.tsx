// 职责：批复队列（P0 一等表面，§4）—— 聚合项目内所有 Waiting（plan/permission/acceptance/cost），
// 每张显示"要什么 + 为什么 + 卡了多久"，决策（批准/拒绝）必须带评论送达 agent。
import { useEffect, useState } from 'react';
import { useUi } from '../store/ui';
import { Icon } from '../components/icons';
import { listApprovals, decideApproval, listPolicies, deletePolicy, listSuspendedApprovals, resumeApproval, resumeAllApprovals, type ApprovalItem, type PolicyRow } from '../api/client';
import { Markdown } from '../components/Markdown';
import { AcceptanceEvidence } from '../components/AcceptanceEvidence';

const KIND_LABEL: Record<string, string> = {
  plan: '计划确认',
  calibrate: '验收标准提案',
  checkpoint: '阶段确认',
  permission: '权限请求',
  acceptance: '验收',
  cost: '成本预算',
};

const KIND_ICON: Record<string, string> = { plan: 'doc', calibrate: 'doc', checkpoint: 'doc', permission: 'lock', acceptance: 'check', cost: 'warn' };

export function ApprovalsView({ pid }: { pid: string }) {
  const [items, setItems] = useState<ApprovalItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [comments, setComments] = useState<Record<number, string>>({});
  const [remembers, setRemembers] = useState<Record<number, boolean>>({});
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
  const decide = async (id: number, outcome: 'approved' | 'rejected', remember = remembers[id] ?? false) => {
    try {
      const ok = await decideApproval(id, outcome, comments[id] ?? '', remember);
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
        {loading && items.length === 0 && <p className="muted">加载中…</p>}
        {!loading && items.length === 0 && (
          <p className="muted">现在没有要批的事项。任务停下等人时会出现在这里。</p>
        )}
        {items.map((a) => (
          <div key={a.id} className="approval">
            <div className="appr-head">
              <Icon name={KIND_ICON[a.kind] as 'lock' | 'check' | 'warn' | 'doc'} size="sm" />
              <strong>{KIND_LABEL[a.kind] ?? a.kind}</strong>
              <span className="muted">#{a.id} · {a.task_title ?? a.execution_id.slice(0, 8)}</span>
              {a.card_kind ? <span className="tag">{a.card_kind}</span> : null}
            </div>
            {a.policy_suggestion ? (
              <div className="policy-suggest" onClick={() => void decide(a.id, a.policy_suggestion!.outcome, true)}>
                🧠 历史策略：{a.policy_suggestion.scope === 'global' ? '项目' : a.policy_suggestion.scope}类已{a.policy_suggestion.outcome === 'approved' ? '批准' : '拒绝'} {a.policy_suggestion.count} 次 —— 一键采用（仅本次，不静默）
              </div>
            ) : null}
            <div className="appr-reason">{a.reason || '（无原因说明）'}</div>
            {a.kind === 'acceptance' ? <AcceptanceEvidence payload={a.payload} /> : null}
            <div className="appr-payload">
              {a.kind === 'acceptance' ? null : Object.entries(a.payload).map(([k, v]) => {
                if (k === 'plan' && typeof v === 'string' && v.length > 40) {
                  return (
                    <details key={k} className="appr-plan" open>
                      <summary>📋 计划内容</summary>
                      <div className="appr-plan-body"><Markdown text={v} /></div>
                    </details>
                  );
                }
                if (k === 'criteria_proposal' && typeof v === 'string' && v.length > 20) {
                  return (
                    <details key={k} className="appr-plan" open>
                      <summary>🧪 验收标准提案（批准 → 写回卡的验收标准）</summary>
                      <div className="appr-plan-body"><Markdown text={v} /></div>
                    </details>
                  );
                }
                if (k === 'summary' && typeof v === 'string' && v.length > 20) {
                  return (
                    <details key={k} className="appr-plan" open>
                      <summary>📈 阶段小结（目标模式检查点）</summary>
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
              <label className="appr-remember" title="沉淀为策略原子：同类批复 count≥2 后给出建议">
                <input
                  type="checkbox"
                  checked={remembers[a.id] ?? false}
                  onChange={(e) => setRemembers((r) => ({ ...r, [a.id]: e.target.checked }))}
                />
                记住
              </label>
              <button className="btn primary" onClick={() => void decide(a.id, 'approved')}>✅ 批准</button>
              <button className="btn" onClick={() => void decide(a.id, 'rejected')}>✋ 拒绝</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
