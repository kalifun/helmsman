// 职责：卡详情抽屉 —— M2.3（O1=B）卡/执行两层：
//   卡头（标题 + 里程碑 + 状态 = 最新执行）；「执行代次」选择条（1 卡 N 执行的 N，可切换 + fork 新代）；
//   页签 评论/简报/产物/轨迹 作用于**选中的执行**（= 会话）。
// 评论 = 用户控制通道（服务端只折叠 user/message）；agent 执行过程归「轨迹」。
// 轨迹 = dsh 轨迹模型（参考 packages/client/ui-trajectory）：按回合分组、每行 #N · 类型标签 · 单行摘要 ·
// 偏移时间；工具行 call+result 合并（名称/成败/参数详情/耗时）；底部成本块 + 流式尾巴。
import { useEffect, useRef, useState } from 'react';
import { useUi, writeHash, type DrawerTab } from '../store/ui';
import { listApprovals, decideApproval, MODE_LABEL, SETTING_LABEL, APPROVAL_LABEL, SANDBOX_LABEL } from '../api/client';
import {
  useProjection, effectiveStatus, depsUnmet, estCost, cacheHitOf, fmtTime,
  latestExecution, executionList,
  type Activity, type TaskState,
} from '../store/projection';
import { StatusPill } from '../components/StatusPill';
import { Button } from '../components/Button';
import { Icon } from '../components/icons';

const TABS: { id: DrawerTab; label: string }[] = [
  { id: 'comments', label: '评论' },
  { id: 'brief', label: '简报' },
  { id: 'artifact', label: '产物' },
  { id: 'trajectory', label: '轨迹' },
];

interface TrajRow {
  idx: number;
  turn: number;
  at?: number;
  kind: 'text' | 'think' | 'tool';
  name?: string;
  args?: string;
  err?: boolean;
  text?: string;
  /** 工具耗时 ms（result.at - start.at） */
  ms?: number;
}

/** 活动 → 轨迹行（合并 ToolStart/ToolResult；带 at/turn 供分组与耗时） */
function toRows(t: TaskState): TrajRow[] {
  const toolById: Record<string, { args: string }> = {};
  (t.tool_calls || []).forEach((tc) => { toolById[tc.call_id] = tc; });
  const rows: TrajRow[] = [];
  const acts = t.activities;
  let i = 0;
  while (i < acts.length) {
    const a: Activity = acts[i];
    if ('ToolStart' in a) {
      let res: Activity | null = null;
      let j = i + 1;
      if (j < acts.length && 'ToolResult' in acts[j]) { res = acts[j]; j++; }
      const tr = res && 'ToolResult' in res ? res.ToolResult : null;
      const startAt = a.ToolStart.at;
      rows.push({
        idx: i, turn: a.ToolStart.turn ?? 0, at: startAt,
        kind: 'tool', name: a.ToolStart.name,
        args: tr ? toolById[tr.name]?.args : '',
        err: tr ? tr.is_error : false,
        ms: startAt != null && tr?.at != null ? Math.max(0, tr.at - startAt) : undefined,
      });
      i = j;
    } else if ('Reasoning' in a) {
      rows.push({ idx: i, turn: a.Reasoning.turn ?? 0, at: a.Reasoning.at, kind: 'think', text: a.Reasoning.text }); i++;
    } else if ('Text' in a) {
      rows.push({ idx: i, turn: a.Text.turn ?? 0, at: a.Text.at, kind: 'text', text: a.Text.text }); i++;
    } else { i++; }
  }
  return rows;
}

const TAG: Record<TrajRow['kind'], string> = { tool: '工具', think: '思考', text: '消息' };

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
  const unmet = task ? depsUnmet(task, byId) : [];
  const comments = task?.comments || [];
  const online = conn === 'online';

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
      return (
        <>
          <details className="rulebox" open>
            <summary>装配规则</summary>
            <div className="rule">来源只取 4 类：任务定义 / 父任务结论 / 知识库检索（带相关度）/ 活状态现取。</div>
            <div className="rule">活状态永不缓存；知识与引用带时效，过期先核对；项目约定长期复用。</div>
            <div className="rule">冲突时活状态 &gt; 结论 &gt; 知识库；冲突写入简报留痕。</div>
            <div className="rule">简报有预算上限，评论是最高优先级输入，不被裁剪。</div>
          </details>
          <div className="ph-empty">简报 = 目标契约（brief/assembled · 接口未开）</div>
          <div className="budget">预算 8k tokens · 已用 —<div className="pipeline">检索：双时态过滤 → 双路召回 → 融合重排 → 阈值过滤 → 进简报</div></div>
        </>
      );
    }
    if (tab === 'artifact') {
      return (
        <>
          <div className="ph-empty">任务尚未完成，暂无产物</div>
          <div className="note">产物 = 目标契约（结论卡沉淀 · 接口未开）。下游引用结论卡，而不是聊天记录。</div>
        </>
      );
    }
    return renderTrajectory();
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
              <div className="cbub">{c.text}</div>
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
  const renderTrajectory = () => {
    const rows = task ? toRows(task) : [];
    const runningNow = st === 'Running' || st === 'Waiting';
    const base = task?.started_at ?? rows[0]?.at;
    const cost = estCost(execUsage);
    const hit = cacheHitOf(execUsage);

    // 按回合分组
    const groups: { turn: number; rows: TrajRow[] }[] = [];
    rows.forEach((r) => {
      const g = groups[groups.length - 1];
      if (!g || g.turn !== r.turn) groups.push({ turn: r.turn, rows: [r] });
      else g.rows.push(r);
    });

    const offset = (at?: number): string => {
      if (at == null || base == null) return '';
      const ms = at - base;
      return '+' + (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms');
    };

    return (
      <>
        <div className="sess-meta">
          <span className="kv">模型 <b>{task?.model || '-'}</b></span>
          <span className="kv">回合 <b>{task?.turns ?? 0}</b></span>
          <span className="kv">步骤 <b>{task?.steps ?? 0}</b></span>
          <span className="kv">seq <b>{task?.last_seq ?? 0}</b></span>
        </div>
        {groups.length === 0 && !stream && <div className="ph-empty">暂无轨迹（引擎执行中或未开始）</div>}
        {groups.map((g) => (
          <div key={g.turn} className="traj-group">
            <div className="traj-group-head">回合 {g.turn || 1}</div>
            {g.rows.map((r, k) => {
              const label = TAG[r.kind];
              const time = offset(r.at);
              const isErr = r.kind === 'tool' && r.err;
              if (r.kind === 'think') {
                return (
                  <details key={k} className="traj-row" data-kind="think">
                    <summary className="traj-main">
                      <span className="traj-index">#{r.idx + 1}</span>
                      <span className="traj-tag" data-kind="think">{label}</span>
                      <span className="traj-text">{r.text?.slice(0, 60) || '思考'}</span>
                      <span className="traj-time">{time}</span>
                    </summary>
                    <div className="traj-detail think">{r.text}</div>
                  </details>
                );
              }
              if (r.kind === 'tool') {
                return (
                  <details key={k} className="traj-row" data-kind="tool" data-err={isErr || undefined}>
                    <summary className="traj-main">
                      <span className="traj-index">#{r.idx + 1}</span>
                      <span className="traj-tag" data-kind="tool">{label}</span>
                      <span className="traj-tool-name">{r.name}</span>
                      <span className={r.err ? 'err' : 'ok'}>{r.err ? '失败' : '成功'}</span>
                      {r.ms != null ? <span className="traj-ms">{r.ms} ms</span> : null}
                      <span className="traj-time">{time}</span>
                    </summary>
                    {r.args ? <div className="traj-detail mono">{r.args}</div> : null}
                  </details>
                );
              }
              const errCls = (r.text || '').indexOf('失败') === 0 ? ' err' : '';
              return (
                <div key={k} className="traj-row" data-kind="text">
                  <span className="traj-index">#{r.idx + 1}</span>
                  <span className="traj-tag" data-kind="text">{label}</span>
                  <span className={'traj-text' + errCls}>{r.text}</span>
                  <span className="traj-time">{time}</span>
                </div>
              );
            })}
          </div>
        ))}
        {runningNow && stream ? (
          <div className="traj-row" data-kind="text" data-stream="true">
            <span className="traj-index">▌</span>
            <span className="traj-tag" data-kind="text">流</span>
            <span className="traj-text">{stream}</span>
          </div>
        ) : null}
        {runningNow ? <div className="sess-caret">▌</div> : null}

        {execUsage ? (
          <div className="cost-block">
            <div className="t">回合成本（本执行）</div>
            <div className="cost-row">
              <span>
                输入 {execUsage.inputTokens.toLocaleString()} · 输出 {execUsage.outputTokens.toLocaleString()} · 缓存读 {execUsage.cacheReadTokens.toLocaleString()} · 思考 {execUsage.reasoningTokens.toLocaleString()}
              </span>
            </div>
            <div className="cost-row"><span>缓存命中率（本执行）</span><b>{hit == null ? '—' : Math.round(hit * 100) + '%'}</b></div>
            <div className="cost-row total"><span>估算</span><span>¥ {cost == null ? '—' : cost.toFixed(4)}</span></div>
            <div className="ph-hint2" style={{ marginTop: 6 }}>定价表：输入 ¥2 / 输出 ¥8 / 缓存读 ¥0.2 / 思考 ¥8（每 M token）</div>
          </div>
        ) : (
          <div className="note">usage 从 WS assistant/message 累积；无数据（服务重启前已完成的会话）显示 —。</div>
        )}
      </>
    );
  };

  return (
    <aside id="drawer" className="open">
      <div className="drawer-head">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <h2 style={{ flex: 1, minWidth: 0 }}>{card.title || cardId.slice(0, 16)}</h2>
          <Button variant="icon" onClick={close} title="关闭（Esc）" aria-label="关闭">
            <Icon name="plus" size="sm" style={{ transform: 'rotate(45deg)' }} />
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
          {unmet.length ? <span style={{ color: 'var(--yellow)' }}>等上游：{unmet.join('、')}</span> : null}
          {task?.waiting ? <span className="waiting-chip">⏸ 待批复：{task.waiting.kind}</span> : null}
          {st === 'Running' ? <Button mini variant="ghost" onClick={cancel} disabled={!online}>⏹ 停止</Button> : null}
          <Button mini variant="ghost" onClick={fork} disabled={!online} title="从当前执行派生新执行代次（保留原事件流）">⑂ fork</Button>
        </div>
      </div>

      {/* Waiting 批复条（§5 会话钻入）：任务停在等待批复时显示，决策走批复队列 */}
      {task?.waiting ? (
        <div className="approval-bar">
          <div className="appr-bar-info">
            <strong>⏸ 等待批复 · {task.waiting.kind}</strong>
            <div className="muted">{task.waiting.reason || '（无原因说明）'}</div>
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
          <Button mini variant="ghost" onClick={fork} disabled={!online} title="从当前执行派生新执行">+ fork</Button>
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
