// 职责：项目首页 —— 状态徽章组（按卡的最新执行状态）+ 需要你处理（失败/待确认目标契约）
// + 正在发生（运行中）+ 最近沉淀（知识库目标契约）+ 操作（新建卡/简单会话/跑全部）+ 项目设置（目标契约只读）。
// M2.3（O1=B）：项目按卡聚合；看板卡 = 资产卡（1 卡 N 执行，状态 = 最新执行）。
import { useState } from 'react';
import { useUi, writeHash } from '../store/ui';
import {
  useProjection, cardStatus, latestExecution, activityText,
  type CardState,
} from '../store/projection';
import { StatusPill } from '../components/StatusPill';
import { Button } from '../components/Button';
import { Icon } from '../components/icons';
import { RemoveProjectModal } from '../components/modals/RemoveProjectModal';

export function ProjectHomeView({ pid }: { pid: string }) {
  const [removeOpen, setRemoveOpen] = useState(false);
  const project = useProjection((s) => s.projects[pid]);
  const pending = useUi((s) => s.pendingProjects[pid]);
  const cards = useProjection((s) => s.cards[pid] || {});
  const setNewTaskOpen = useUi((s) => s.setNewTaskOpen);
  const toast = useUi((s) => s.toast);

  const clist = Object.values(cards);
  const counts: Record<string, number> = { Pending: 0, Running: 0, Done: 0, Failed: 0, Cancelled: 0 };
  clist.forEach((c) => { counts[cardStatus(c)] += 1; });
  const failed = clist.filter((c) => cardStatus(c) === 'Failed');
  const running = clist.filter((c) => cardStatus(c) === 'Running');
  const isPending = !project && !!pending;
  const name = project?.name ?? pending?.name ?? pid;
  const path = project?.path ?? pending?.path ?? '';

  const goView = (view: 'kanban' | 'chat' | 'graph' | 'kb' | 'files') => {
    useUi.getState().setRoute({ view, openId: null, tab: 'comments' });
    writeHash(pid, view, null, 'comments');
  };

  const lastText = (c: CardState): string => {
    const e = latestExecution(c);
    if (e && e.activities.length) return activityText(e.activities[e.activities.length - 1]).slice(0, 24);
    return '';
  };

  return (
    <div id="projhome">
      {isPending ? (
        <div className="banner warn" style={{ marginBottom: 18 }}>
          新项目待注册（离线兜底）：可先建第一张卡（POST /api/projects/:pid/cards），或重新打开「新建项目」显式注册。
        </div>
      ) : null}
      <div className="ph-head">
        <h1>{name}</h1>
        <div className="ph-path">{path || '—'}</div>
        <div className="ph-status">
          {(['Running', 'Failed', 'Pending', 'Done', 'Cancelled'] as const)
            .filter((k) => counts[k] > 0)
            .map((k) => <StatusPill key={k} status={k} label={(k === 'Running' ? '运行中 ' : k === 'Failed' ? '失败 ' : k === 'Pending' ? '待办 ' : k === 'Done' ? '完成 ' : '已取消 ') + counts[k]} />)}
          <span style={{ color: 'var(--text3)', fontFamily: 'var(--mono)', fontSize: 11 }}>· {clist.length} 张卡</span>
        </div>
      </div>

      <div className="ph-cols">
        <div className="ph-col">
          <div className="ph-sec">
            <div className="ph-sec-t">需要你处理</div>
            {failed.length ? failed.map((c) => (
              <div key={c.id} className="ph-item fl" data-card={c.id} onClick={() => openDetail(pid, c.id, 'comments')}>
                <StatusPill status="Failed" />
                <span className="at">{c.title || c.id.slice(0, 12)}</span>
                <span className="aq">{lastText(c)}</span>
                <Button mini variant="ghost" onClick={(e) => { e.stopPropagation(); toast('重跑 = fork 新执行代次（卡详情页操作）'); }}>重跑</Button>
                <Button mini onClick={(e) => { e.stopPropagation(); openDetail(pid, c.id, 'comments'); }}>查看</Button>
              </div>
            )) : <div className="ph-empty">没有需要你处理的任务</div>}
            <div className="ph-hint2">待确认 = 目标契约（approval 缝 · P0 未开）</div>
          </div>

          <div className="ph-sec">
            <div className="ph-sec-t">正在发生</div>
            {running.length ? running.map((c) => (
              <div key={c.id} className="ph-item rn" onClick={() => openDetail(pid, c.id, 'comments')}>
                <span className="dot Running" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--blue)', animation: 'pulse 1.6s infinite' }} />
                <span className="at">{c.title || c.id.slice(0, 12)}</span>
                <span className="aq">{lastText(c)}</span>
              </div>
            )) : <div className="ph-empty">没有正在执行的任务</div>}
          </div>

          <div className="ph-sec">
            <div className="ph-sec-t">仓库</div>
            <div className="ph-empty">仓库活状态现取</div>
            <div className="ph-hint2">目标契约（git/workspace 接口未开 · spec §4.1 规则②）</div>
          </div>
        </div>

        <div className="ph-col">
          <div className="ph-sec">
            <div className="ph-sec-t">最近沉淀</div>
            <div className="ph-empty">知识库为空</div>
            <div className="ph-hint2">知识库 = 目标契约（kb 接口未开 · P0）</div>
          </div>
          <div className="ph-sec">
            <div className="ph-sec-t">操作</div>
            <div className="ph-actions">
              <Button onClick={() => setNewTaskOpen(true)}><Icon name="plus" size="sm" />新建卡</Button>
              <Button onClick={() => goView('chat')}><Icon name="chat" size="sm" />简单会话</Button>
              <Button variant="primary" onClick={() => { toast('卡创建即自动执行首代；如需新执行代次在卡详情 fork'); useProjection.getState().bump(); }}>
                <Icon name="play" size="sm" />跑全部
              </Button>
              <Button variant="ghost" onClick={() => setRemoveOpen(true)} style={{ color: 'var(--text3)' }}>
                移除项目
              </Button>
            </div>
          </div>
          {removeOpen ? <RemoveProjectModal pid={pid} name={name} onClose={() => setRemoveOpen(false)} /> : null}
        </div>
      </div>

      <details className="settings">
        <summary>项目设置</summary>
        <div className="row"><span>模型分层</span><span className="dim">auto（flash-first · 目标契约）</span></div>
        <div className="row"><span>检索阈值</span><span className="dim">0.55（目标契约）</span></div>
        <div className="row"><span>简报预算</span><span className="dim">8k tokens（目标契约）</span></div>
        <div className="row"><span>并发上限</span><span className="dim">2（目标契约）</span></div>
        <div className="row"><span>凭据</span><span className="dim">DEEPSEEK_API_KEY（env）</span></div>
        <div className="row"><span>项目指令</span><span className="dim">AGENTS.md（目标契约）</span></div>
      </details>
    </div>
  );
}

// 抽屉打开（跨视图复用；openId = 卡 id，抽屉内选执行代次）
function openDetail(pid: string, cardId: string, tab: 'comments' | 'brief' | 'artifact' | 'trajectory') {
  useUi.getState().setRoute({ pid, openId: cardId, tab });
  writeHash(pid, useUi.getState().view, cardId, tab);
}