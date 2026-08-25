// 职责：项目首页 —— 状态徽章组（按卡的最新执行状态）+ 需要你处理（失败/待确认目标契约）
// + 正在发生（运行中）+ 最近沉淀（知识库目标契约）+ 操作（新建卡/简单会话/跑全部）+ 项目设置（目标契约只读）。
// M2.3（O1=B）：项目按卡聚合；看板卡 = 资产卡（1 卡 N 执行，状态 = 最新执行）。
import { useEffect, useState } from 'react';
import { useUi, writeHash } from '../store/ui';
import {
  useProjection, cardStatus, latestExecution, activityText,
  type CardState,
} from '../store/projection';
import { StatusPill } from '../components/StatusPill';
import { Button } from '../components/Button';
import { Icon } from '../components/icons';
import { TaskRows, type TaskRowItem } from '../components/TaskRows';
import { RemoveProjectModal } from '../components/modals/RemoveProjectModal';
import { ContextCards, type ContextChunk } from '../components/ContextCards';
import { listKbNotes, listApprovals, type KbNoteRow } from '../api/client';

export function ProjectHomeView({ pid }: { pid: string }) {
  const [removeOpen, setRemoveOpen] = useState(false);
  const [kbRecent, setKbRecent] = useState<KbNoteRow[]>([]);
  const [repo, setRepo] = useState<{ branch: string; dirty: number; staged: number; untracked: number; conflicted: number; ahead: number; behind: number; lastCommit: string; error?: string } | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
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

  // 真实实现接入：最近沉淀（KB）/ 仓库活状态（文件树顶层）/ 待批复计数
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [notes, approvals] = await Promise.all([listKbNotes(pid), listApprovals(pid)]);
        if (!alive) return;
        setKbRecent(notes.filter((n) => n.validUntil === null).sort((a, b) => b.validFrom - a.validFrom).slice(0, 4));
        setPendingCount(approvals.length);
      } catch { /* 首页数据失败不阻塞 */ }
      try {
        const r = await fetch(`/api/projects/${encodeURIComponent(pid)}/repo-status`);
        if (r.ok) {
          const rs = (await r.json()) as { branch: string; dirty: number; staged: number; untracked: number; conflicted: number; ahead: number; behind: number; lastCommit: string; error?: string };
          if (alive) setRepo(rs);
        }
      } catch { /* 仓库状态失败忽略 */ }
    })();
    return () => { alive = false; };
  }, [pid]);

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
            {failed.length ? (
              <TaskRows
                items={failed.map<TaskRowItem>((c) => {
                  const e = latestExecution(c);
                  return {
                    id: c.id,
                    title: c.title || c.id.slice(0, 12),
                    status: 'failed',
                    meta: `执行 ×${c.execution_count ?? Object.keys(c.executions).length}`,
                    detail: e && e.activities.length
                      ? [{ label: '最后活动', value: activityText(e.activities[e.activities.length - 1]).slice(0, 60) }]
                      : undefined,
                    onClick: () => openDetail(pid, c.id, 'comments'),
                  };
                })}
              />
            ) : <div className="ph-empty">没有需要你处理的任务</div>}
            <div className="ph-hint2">{pendingCount > 0 ? `待批复 ${pendingCount} 项 · 批复队列查看` : '没有待批复事项'}</div>
          </div>

          <div className="ph-sec">
            <div className="ph-sec-t">正在发生</div>
            {running.length ? (
              <TaskRows
                items={running.map<TaskRowItem>((c) => {
                  const e = latestExecution(c);
                  return {
                    id: c.id,
                    title: c.title || c.id.slice(0, 12),
                    status: 'running',
                    progress: e?.steps ?? e?.turns,
                    meta: lastText(c),
                    onClick: () => openDetail(pid, c.id, 'comments'),
                  };
                })}
              />
            ) : <div className="ph-empty">没有正在执行的任务</div>}
          </div>

          <div className="ph-sec">
            <div className="ph-sec-t">仓库</div>
            {repo === null ? (
              <div className="ph-empty">加载仓库状态…</div>
            ) : repo.error ? (
              <div className="ph-empty">{repo.error === 'not a git repo' ? '不是 git 仓库' : '仓库状态不可读'}</div>
            ) : (
              <div className="repo-status" onClick={() => goView('files')} role="button" title="查看文件">
                <div className="repo-row">
                  <span className="tag">分支</span>
                  <b className="repo-branch">{repo.branch || '（无分支）'}</b>
                  {(repo.ahead > 0 || repo.behind > 0) ? (
                    <span className="repo-sync" title="与远端对比">{repo.ahead > 0 ? `↑${repo.ahead}` : ''}{repo.ahead > 0 && repo.behind > 0 ? ' ' : ''}{repo.behind > 0 ? `↓${repo.behind}` : ''}</span>
                  ) : null}
                  {repo.conflicted > 0 ? (
                    <span className="repo-conflict">冲突 {repo.conflicted} 个</span>
                  ) : repo.dirty > 0 ? (
                    <span className={'repo-dirty' + (repo.staged > 0 ? ' staged' : '')}>
                      {repo.dirty} 个改动
                      {repo.staged > 0 ? ` · ${repo.staged} 已暂存` : ''}
                      {repo.untracked > 0 ? ` · ${repo.untracked} 新文件` : ''}
                    </span>
                  ) : (
                    <span className="repo-clean">工作区干净</span>
                  )}
                </div>
                {repo.lastCommit ? (
                  <div className="repo-commit">{repo.lastCommit}</div>
                ) : null}
              </div>
            )}
          </div>
        </div>

        <div className="ph-col">
          <div className="ph-sec">
            <div className="ph-sec-t">最近沉淀</div>
            {kbRecent.length ? (
              <ContextCards
                chunks={kbRecent.map<ContextChunk>((n) => ({
                  id: n.id,
                  title: n.title,
                  content: n.content.slice(0, 2).join('\n'),
                  chars: n.content.reduce((acc, l) => acc + l.length, 0),
                  onClick: () => goView('kb'),
                  sourceKind: n.source.kind,
                  sourceRef: n.source.ref,
                  badges: [{ label: n.trust === 'human-approved' ? '人工确认' : n.trust === 'agent-generated' ? '自动沉淀' : '未验证', tone: n.trust === 'human-approved' ? 'ok' : n.trust === 'agent-generated' ? 'info' : 'muted' }],
                }))}
                showHead={false}
                empty=""
              />
            ) : <div className="ph-empty">知识库为空 —— 任务完成后结论自动沉淀到这里</div>}
            <div className="ph-hint2">最近沉淀的结论 · 点击进入知识库</div>
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