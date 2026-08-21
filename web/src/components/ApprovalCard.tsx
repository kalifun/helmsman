// 职责：批复卡（Beautiful UI「Approval Card」移植，MIT © Shane Levine）——
//   「要什么 + 为什么 + 卡了多久」卡片化；决策（批准/拒绝）带评论，评论与「记住」为组件局部状态，经 onDecide 上抛。
// 主题：沿用 Helmsman 25 键语义 token（surface/line/text*/bg*/shadow-hover），无 Tailwind、无新依赖。
import { useState } from 'react';
import { Icon, type IconName } from './icons';
import { Markdown } from './Markdown';
import { AcceptanceEvidence } from './AcceptanceEvidence';
import { RecommendationCard } from './RecommendationCard';
import type { ApprovalItem } from '../api/client';

export const KIND_LABEL: Record<ApprovalItem['kind'], string> = {
  plan: '计划确认',
  calibrate: '验收标准提案',
  checkpoint: '阶段确认',
  permission: '权限请求',
  acceptance: '验收',
  cost: '成本预算',
};

const KIND_ICON: Record<ApprovalItem['kind'], IconName> = {
  plan: 'doc', calibrate: 'doc', checkpoint: 'doc', permission: 'lock', acceptance: 'check', cost: 'warn',
};

/** 卡了多久（created_at epoch ms → 相对时长，走 --fs-xs mono 呈现） */
export function approvalElapsed(createdAt: number): string {
  const s = Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
  if (s < 60) return s + ' 秒';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时';
  return Math.floor(s / 86400) + ' 天';
}

export interface ApprovalCardProps {
  item: ApprovalItem;
  /** 决策上抛（outcome, comment, remember）；返回 Promise 时卡片自带 pending 防抖 */
  onDecide: (outcome: 'approved' | 'rejected', comment: string, remember: boolean) => void | Promise<void>;
}

export function ApprovalCard({ item: a, onDecide }: ApprovalCardProps) {
  const [comment, setComment] = useState('');
  const [remember, setRemember] = useState(false);
  const [pending, setPending] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const decide = async (outcome: 'approved' | 'rejected', c = comment, r = remember) => {
    if (pending) return;
    setPending(true);
    try {
      await onDecide(outcome, c, r);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="appr-card">
      <div className="appr-card-head">
        <div className="appr-kick" data-kind={a.kind}>
          <span className="kicon"><Icon name={KIND_ICON[a.kind]} size="sm" /></span>
          <div className="kick-txt">
            <div className="kick-row">
              <span className="appr-kind">{KIND_LABEL[a.kind]}</span>
              <span className="appr-when">等 {approvalElapsed(a.created_at)}</span>
            </div>
            <div className="appr-title" title={a.task_title ?? a.execution_id}>
              {a.task_title ?? a.execution_id.slice(0, 24)}
              <span className="appr-id"> · #{a.id}</span>
              {a.card_kind ? <span className="tag" style={{ marginLeft: 6 }}>{a.card_kind}</span> : null}
            </div>
          </div>
        </div>
      </div>

      <div className="appr-q">
        <div className="q-kicker">为什么卡住</div>
        <div className="q-text">{a.reason || '（无原因说明）'}</div>
      </div>

      {!dismissed && a.policy_suggestion ? (
        <div className="appr-payload" style={{ paddingTop: 10 }}>
          <RecommendationCard
            compact
            title={`历史策略建议 · ${a.policy_suggestion.scope === 'global' ? '项目' : a.policy_suggestion.scope}类已${a.policy_suggestion.outcome === 'approved' ? '批准' : '拒绝'} ${a.policy_suggestion.count} 次`}
            description="一键采用（仅本次，不静默）"
            confidence={a.policy_suggestion.count >= 3 ? 'high' : a.policy_suggestion.count === 2 ? 'needs-review' : 'no-signal'}
            acceptLabel="采用"
            alternativeLabel="不采用"
            onAccept={() => void decide(a.policy_suggestion!.outcome, '按历史策略执行', true)}
            onAlternative={() => setDismissed(true)}
          />
        </div>
      ) : null}

      {a.kind === 'acceptance' ? <AcceptanceEvidence payload={a.payload} /> : null}

      <div className="appr-payload">
        {a.kind === 'acceptance'
          ? null
          : Object.entries(a.payload).map(([k, v]) => {
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

      <div className="appr-foot">
        <input
          className="appr-comment-input"
          placeholder="批复评论（送达 agent）"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          aria-label="批复评论"
        />
        <label className="appr-remember" title="沉淀为策略原子：同类批复 count≥2 后给出建议">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          记住
        </label>
        <div className="appr-actions">
          <button className="btn primary" disabled={pending} onClick={() => void decide('approved')}>批准</button>
          <button className="btn" disabled={pending} onClick={() => void decide('rejected')}>拒绝</button>
        </div>
      </div>
    </div>
  );
}
