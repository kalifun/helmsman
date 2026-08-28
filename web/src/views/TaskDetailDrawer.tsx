// 职责：卡详情抽屉 —— M2.3（O1=B）卡/执行两层：
//   卡头（标题 + 里程碑 + 状态 = 最新执行）；「执行代次」选择条（1 卡 N 执行的 N，可切换 + fork 新代）；
//   页签 评论/简报/产物/轨迹 作用于**选中的执行**（= 会话）。
// 评论 = 用户控制通道（服务端只折叠 user/message）；agent 执行过程归「轨迹」。
// 轨迹 = dsh 轨迹模型（参考 packages/client/ui-trajectory）：按回合分组、每行 #N · 类型标签 · 单行摘要 ·
// 偏移时间；工具行 call+result 合并（名称/成败/参数详情/耗时）；底部成本块 + 流式尾巴。
import { useEffect, useRef, useState } from 'react';
import { useUi, writeHash, openSession, type DrawerTab } from '../store/ui';
import { listApprovals, decideApproval, getMetrics, MODE_LABEL, SETTING_LABEL, APPROVAL_LABEL, SANDBOX_LABEL } from '../api/client';
import {
  useProjection, effectiveStatus, cardStatus, cardUnmet, waitingLabel, fmtTime,
  latestExecution, executionList,
  type TaskState,
} from '../store/projection';
import { StatusPill } from '../components/StatusPill';
import { TrajectoryView } from './TrajectoryView';
import { Markdown } from '../components/Markdown';
import { AcceptanceEvidence } from '../components/AcceptanceEvidence';
import { ContextCards } from '../components/ContextCards';
import { Button } from '../components/Button';
import { Icon } from '../components/icons';
import type { KbNoteRow } from '../api/client';

const TABS: { id: DrawerTab; label: string }[] = [
  { id: 'comments', label: '评论' },
  { id: 'brief', label: '简报' },
  { id: 'artifact', label: '产物' },
  { id: 'trajectory', label: '轨迹' },
];

export function TaskDetailDrawer({ pid, cardId }: { pid: string; cardId: string }) {
  const tab = useUi((s) => s.tab);
  const card = useProjection((s) => s.cards[pid]?.[cardId]);
  const usage = useProjection((s) => s.usage);
  const streams = useProjection((s) => s.streams);
  const conn = useProjection((s) => s.conn);
  const projects = useProjection((s) => s.projects);
  const toast = useUi((s) => s.toast);

  // 选中的执行代次（默认最新；卡刷新后若选中代次消失则回落最新）
  const execs = executionList(card);
  const [selSid, setSelSid] = useState<string | null>(null);
  const selSidEffective = selSid && card?.executions[selSid] ? selSid : (latestExecution(card)?.id ?? null);
  const task = selSidEffective ? card?.executions[selSidEffective] : undefined;
  const sid = task?.id ?? selSidEffective ?? '';
  const execUsage = usage[sid];
  const stream = streams[sid];
  const cardExecs = card ? Object.values(card.executions) : [];
  const byId: Record<string, TaskState> = {};
  cardExecs.forEach((e) => { byId[e.id] = e; });
  // 依赖契约（目标契约 taskgraph）：deps 是卡 id → 卡最新执行；反向扫描被依赖
  const allCards = useProjection((s) => s.cards[pid] || {});
  const revDeps = Object.values(allCards)
    .filter((c) => c.deps?.includes(cardId))
    .map((c) => ({ id: c.id, title: c.title, status: cardStatus(c) }));

  // 简报快照（metrics.brief_snapshot，按执行 sid）与卡产物（KB 笔记 source_ref=cardId）
  const [briefRows, setBriefRows] = useState<Record<string, { brief_snapshot: Array<{ id: string; title: string; score?: number }>; usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; reasoningTokens: number } }>>({});
  const [kbNotes, setKbNotes] = useState<KbNoteRow[]>([]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const m = await getMetrics(pid);
        const map: Record<string, { brief_snapshot: Array<{ id: string; title: string; score?: number }>; usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; reasoningTokens: number } }> = {};
        m.forEach((r) => {
          if (r.task_id) {
            map[r.task_id] = {
              brief_snapshot: r.brief_snapshot ?? [],
              // metrics 持久化 token 用量：WS 实时 usage 无值（历史会话）时回填成本块
              usage: {
                inputTokens: r.in_tokens ?? 0,
                outputTokens: r.out_tokens ?? 0,
                cacheReadTokens: r.cache_tokens ?? 0,
                reasoningTokens: r.reason_tokens ?? 0,
              },
            };
          }
        });
        if (alive) setBriefRows(map);
      } catch { /* 快照加载失败不影响 */ }
      try {
        const r = await fetch(`/api/kb/notes?project=${encodeURIComponent(pid)}`);
        const notes = (await r.json()) as KbNoteRow[];
        if (alive) setKbNotes(Array.isArray(notes) ? notes : []);
      } catch { /* 笔记加载失败不影响 */ }
    })();
    return () => { alive = false; };
  }, [pid, cardId]);

  const setTab = (t: DrawerTab) => {
    useUi.getState().setRoute({ tab: t });
    writeHash(pid, useUi.getState().view, cardId, t);
  };
  const close = () => {
    useUi.getState().closeDetail();
    writeHash(pid, useUi.getState().view, null, 'comments');
  };

  // ESC 关闭抽屉
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const paneRef = useRef<HTMLDivElement>(null);
  const [cInput, setCInput] = useState('');

  useEffect(() => {
    if (paneRef.current) paneRef.current.scrollTop = paneRef.current.scrollHeight;
  }, [tab, task?.activities.length, execUsage, stream]);

  if (!card) return <aside id="drawer" />;
  const st = task ? effectiveStatus(task) : 'Pending';
  const locked = st === 'Running' || st === 'Waiting';
  const unmet = cardUnmet(card, allCards);   // §2.1 调度门：等上游（卡无执行也算）
  const comments = task?.comments || [];
  const online = conn === 'online';

  const jump = (cid: string) => {
    useUi.getState().setRoute({ openId: cid, tab: 'comments' });
    writeHash(pid, useUi.getState().view, cid, 'comments');
  };

  const fork = async () => {
    if (!online) { toast('断连期间禁用控制操作'); return; }
    const newSid = await useProjection.getState().forkExecution(cardId, sid || undefined);
    if (newSid) {
      toast('已 fork 新执行代次（保留原事件流供 diff）');
      setSelSid(newSid);
    } else {
      toast('fork 失败，见错误横幅');
    }
  };

  const calibrate = async () => {
    if (!online) { toast('断连期间禁用控制操作'); return; }
    const newSid = await useProjection.getState().calibrateCard(cardId);
    if (newSid) toast('已发起需求校准：AI 探索提案验收标准 → 批复确认 → 自动写回');
    else toast('校准发起失败，见错误横幅');
  };

  const cancel = async () => {
    if (!online) { toast('断连期间禁用控制操作'); return; }
    const ok = await useProjection.getState().cancelTask(sid);
    toast(ok ? '已发送停止（POST cancel）' : '停止失败');
  };

  const sendComment = async (text: string) => {
    const v = text.trim();
    if (!v) return;
    if (!online) { toast('断连期间禁用控制操作'); return; }
    setCInput('');
    const ok = await useProjection.getState().postComment(sid, v);
    if (ok) {
      toast('评论已发送 · 引擎执行中');
      useProjection.getState().loadCard(cardId);
    } else {
      toast('评论发送失败');
      setCInput(v);
    }
  };

  // 批复决策：从批复队列找到本任务的 approval 并批准/拒绝（Waiting 放行 = 走队列不是发评论）
  const decideWaiting = async (outcome: 'approved' | 'rejected') => {
    if (!online) { toast('断连期间禁用控制操作'); return; }
    if (!task?.waiting) return;
    try {
      const approvals = await listApprovals(pid);
      const appr = approvals.find((a) => a.execution_id === sid && a.outcome === null);
      if (!appr) { toast('未找到待批复项（可能已决策）'); return; }
      const ok = await decideApproval(appr.id, outcome, outcome === 'approved' ? '批准继续' : '需要修改');
      toast(ok ? `已${outcome === 'approved' ? '批准' : '拒绝'} · 决策已送达 agent` : '决策失败');
      if (ok) useProjection.getState().loadCard(cardId);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const renderPane = () => {
    if (tab === 'comments') return renderComments();
    if (tab === 'brief') {
      // 简报 = 实际装配快照（metrics.brief_snapshot：执行启动时的 KB 命中清单）
      const briefRow = briefRows[sid];
      const hits = briefRow?.brief_snapshot ?? [];
      return (
        <>
          <details className="rulebox" open>
            <summary>装配规则</summary>
            <div className="rule">来源只取 4 类：任务定义 / 父任务结论 / 知识库检索（带相关度）/ 活状态现取。</div>
            <div className="rule">活状态永不缓存；知识与引用带时效，过期先核对；项目约定长期复用。</div>
            <div className="rule">冲突时活状态 &gt; 结论 &gt; 知识库；冲突写入简报留痕。</div>
            <div className="rule">简报有预算上限，评论是最高优先级输入，不被裁剪。</div>
          </details>
          {hits.length === 0 ? (
            <div className="ph-empty">该执行无 KB 命中快照（无知识命中或执行早于快照记录）</div>
          ) : (
            <ContextCards
              chunks={hits.map((h) => {
                const note = kbNotes.find((x) => x.id === h.id);
                return {
                  id: h.id,
                  title: h.title,
                  content: note ? note.content.join('\n') : undefined,
                  chars: note ? note.content.reduce((s, l) => s + l.length, 0) : undefined,
                  sourceKind: note?.source.kind,
                  sourceRef: note?.source.ref,
                  score: h.score,
                };
              })}
              title="装配上下文"
              countLabel={`${hits.length} 条`}
            />
          )}
          <div className="budget">预算 8k tokens · 命中 {hits.length} 条<div className="pipeline">检索：双时态过滤 → 双路召回 → 融合重排 → 阈值过滤 → 进简报</div></div>
        </>
      );
    }
    if (tab === 'artifact') {
      // 产物 = 卡关联的结论卡（KB 笔记 source_ref=cardId，验收通过后沉淀）
      const artifacts = kbNotes.filter((n) => n.source?.ref === cardId);
      return (
        <>
          {artifacts.length === 0 ? (
            <>
              <div className="ph-empty">暂无结论卡 —— 执行完成且验收通过后，结论沉淀为知识库条目（下游引用结论卡，而不是聊天记录）</div>
              <div className="note">产物 = 知识库条目（结论卡）。可在「知识库」视图查看全部。</div>
            </>
          ) : (
            <div className="artifact-list">
              {artifacts.map((n) => (
                <div key={n.id} className="artifact-item">
                  <div className="artifact-title">{n.title}</div>
                  <div className="artifact-tags">
                    <span className="tag">{n.trust}</span>
                    <span className="tag">{n.source?.kind}</span>
                    {n.tags?.map((t) => <span key={t} className="tag">{t}</span>)}
                  </div>
                  {n.content?.length ? <div className="artifact-content">{n.content.slice(0, 6).join('\n')}</div> : null}
                  {n.summary ? <div className="artifact-summary">{n.summary}</div> : null}
                </div>
              ))}
            </div>
          )}
        </>
      );
    }
    return task ? (
      <TrajectoryView task={task} stream={tab === 'trajectory' ? stream : undefined} usageOverride={briefRows[sid]?.usage} />
    ) : null;
  };

  const renderComments = () => {
    // 评论 = 用户控制通道（服务端只折叠 user/message）；agent 执行过程见「轨迹」页签
    return (
      <>
        {locked ? (
          <div className="banner warn">运行中/待确认卡片锁死：评论是唯一控制通道，回复即继续。</div>
        ) : null}
        {comments.length === 0 && (
          <div className="ph-empty">暂无评论 · 评论是你的控制通道（指示 / 批复 / 引导）</div>
        )}
        {comments.map((c, i) => (
          <div key={i} className="cmsg user">
            <div className="avatar">你</div>
            <div className="cbody">
              <div className="cmeta">
                <span className="who">你</span>
                <span>{fmtTime(c.at)}</span>
              </div>
              <div className="cbub"><Markdown text={c.text ?? ''} /></div>
            </div>
          </div>
        ))}
        {comments.length > 0 ? (
          <div className="note">agent 的执行过程与回应见「轨迹」页签。</div>
        ) : null}
      </>
    );
  };

  // —— 轨迹（dsh 模型：按回合分组 · #N 行记录 · 偏移时间 · 工具耗时）——
  return (
    <aside id="drawer" className="open">
      <div className="drawer-head">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <h2 style={{ flex: 1, minWidth: 0 }}>{card.title || cardId.slice(0, 16)}</h2>
          <Button mini variant="ghost" onClick={() => openSession(pid, sid, useUi.getState().view, cardId)} title="进入全屏会话（可继续聊）">↗ 进入会话</Button>
          <Button variant="icon" onClick={close} title="关闭（Esc）" aria-label="关闭">
            <Icon name="x" size="sm" />
          </Button>
        </div>
        <div className="drawer-meta">
          <StatusPill status={st as TaskState['status']} />
          {card.milestone ? <span className="milestone-chip">{card.milestone}</span> : null}
          {task?.preset ? (
            <span className="preset-chip" title={`${MODE_LABEL[task.preset.mode as keyof typeof MODE_LABEL] ?? task.preset.mode} × ${SETTING_LABEL[task.preset.setting as keyof typeof SETTING_LABEL] ?? task.preset.setting} × ${APPROVAL_LABEL[task.preset.approval as keyof typeof APPROVAL_LABEL] ?? task.preset.approval} · 沙箱 ${SANDBOX_LABEL[task.preset.sandbox as keyof typeof SANDBOX_LABEL] ?? task.preset.sandbox}`}>
              📋 {task.preset.name}
            </span>
          ) : null}
          <span>{projects[pid]?.name ?? pid}</span>
          {task?.recovered ? <span className="rec" style={{ fontSize: 10, color: 'var(--text3)', border: '1px solid var(--line2)', borderRadius: 6, padding: '0 5px' }}>恢复</span> : null}
          {task?.isolated ? <span title="任务隔离区创建失败，本次执行直接写在共享项目目录" style={{ fontSize: 10, color: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 6, padding: '0 5px' }}>⚠ 共享目录运行</span> : null}
          {unmet.length ? <span style={{ color: 'var(--yellow)' }}>等上游：{unmet.join('、')}</span> : null}
          {task?.worktree ? <span className="tag" title={task.worktree.path}>隔离 · {task.worktree.branch}</span> : null}
          {task?.waiting ? <span className="waiting-chip">⏸ 待批复：{waitingLabel(task.waiting.kind)}</span> : null}
          {st === 'Running' ? <Button mini variant="ghost" onClick={cancel} disabled={!online}>⏹ 停止</Button> : null}
          <Button mini variant="ghost" onClick={fork} disabled={!online || unmet.length > 0} title={unmet.length ? '等上游：依赖未完成，禁止启动' : '从当前执行派生新执行代次（保留原事件流）'}>⑂ fork</Button>
          <Button mini variant="ghost" onClick={calibrate} disabled={!online} title="D1.7：AI 探索提案验收标准 → 你确认 → 自动写回卡的验收标准">🔬 校准需求</Button>
        </div>
      </div>

      {/* 验收标准（需求契约，D1.7）：校准确认后写回，交付档执行完成按此验收 */}
      {card.criteria ? (
        <div className="criteria-bar">
          <span className="criteria-label">验收标准</span>
          <code className="criteria-text">{card.criteria}</code>
        </div>
      ) : null}

      {/* 依赖契约（目标契约 taskgraph）：依赖/被依赖，点 chip 跳到对应卡 */}
      {((task?.deps?.length ?? 0) > 0 || revDeps.length > 0) ? (
        <div className="drawer-deps">
          {(task?.deps?.length ?? 0) > 0 ? (
            <div className="dd-group">
              <span className="dd-label">依赖 · 先完成</span>
              <div className="dd-chips">
                {task!.deps!.map((d) => {
                  const dc = allCards[d];
                  const dle = dc ? latestExecution(dc) : null;
                  return (
                    <button key={d} className="dd-chip" onClick={() => jump(d)} title={dc?.title || d}>
                      <StatusPill status={(dle ? effectiveStatus(dle) : 'Pending') as TaskState['status']} />
                      <span className="dd-title">{dc?.title || d.slice(0, 14)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
          {revDeps.length > 0 ? (
            <div className="dd-group">
              <span className="dd-label">被依赖 · 等本卡</span>
              <div className="dd-chips">
                {revDeps.map((r) => (
                  <button key={r.id} className="dd-chip" onClick={() => jump(r.id)} title={r.title}>
                    <StatusPill status={r.status as TaskState['status']} />
                    <span className="dd-title">{r.title || r.id.slice(0, 14)}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Waiting 批复条（§5 会话钻入）：任务停在等待批复时显示，决策走批复队列 */}
      {task?.waiting ? (
        <div className="approval-bar">
          <div className="appr-bar-info">
            <strong>⏸ 等待批复 · {waitingLabel(task.waiting.kind)}</strong>
            <div className="muted">{task.waiting.reason || '（无原因说明）'}</div>
            {task.waiting.payload?.plan ? (
              <details className="appr-plan" open>
                <summary>📋 计划内容</summary>
                <div className="appr-plan-body"><Markdown text={task.waiting.payload.plan as string} /></div>
              </details>
            ) : null}
            {task.waiting.kind === 'acceptance' ? <AcceptanceEvidence payload={task.waiting.payload} /> : null}
          </div>
          <div className="appr-bar-actions">
            <Button mini variant="primary" onClick={() => void decideWaiting('approved')} disabled={!online}>✅ 批准继续</Button>
            <Button mini onClick={() => void decideWaiting('rejected')} disabled={!online}>✋ 拒绝 / 需修改</Button>
          </div>
        </div>
      ) : null}

      {/* 执行代次选择条：1 卡 N 执行的 N（点选切换；当前代高亮） */}
      {card.execution_count != null && card.execution_count > 1 || execs.length > 1 ? (
        <div className="exec-bar">
          <span className="exec-bar-label">执行代次</span>
          {execs.map((e, i) => (
            <button
              key={e.id}
              className={'exec-chip' + (e.id === sid ? ' active' : '')}
              title={e.title || e.id}
              onClick={() => setSelSid(e.id)}
            >
              <span className={'dot ' + e.status} />代 {i + 1}
              {e.status === 'Running' ? <span className="ellip" style={{ maxWidth: 60 }}> · 运行中</span> : null}
            </button>
          ))}
          <Button mini variant="ghost" onClick={fork} disabled={!online || unmet.length > 0} title={unmet.length ? '等上游：依赖未完成，禁止启动' : '从当前执行派生新执行'}>+ fork</Button>
        </div>
      ) : null}

      <div className="tabs">
        {TABS.map((t) => (
          <div key={t.id} className={'tab' + (tab === t.id ? ' active' : '')} data-tab={t.id} onClick={() => setTab(t.id)}>
            {t.label}
          </div>
        ))}
      </div>
      <div className="tabpane" ref={paneRef}>{renderPane()}</div>
      {tab === 'comments' ? (
        <div className="replybar">
          <textarea
            value={cInput}
            onChange={(e) => setCInput(e.target.value)}
            placeholder={locked ? '回复 agent…（评论即控制 · 回复即继续）' : '回复 agent…'}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void sendComment(cInput);
              }
            }}
          />
          <div className="reply-actions">
            <Button mini onClick={() => void sendComment('批复：批准继续')} disabled={!online} title="快捷批复（steer 语义）">👍 批准继续</Button>
            <Button mini onClick={() => void sendComment('批复：需要修改')} disabled={!online} title="快捷批复（steer 语义）">✋ 需要修改</Button>
            <span className="spacer" />
            <span className="kbd">Enter 发送</span>
            <Button mini variant="primary" disabled={!cInput.trim() || !online} onClick={() => void sendComment(cInput)}>发送</Button>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
