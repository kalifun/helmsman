// 职责：会话钻入独立页（O7：`#/p/:pid/t/:sid` 全屏 DSH 式会话）——
//   聊天视图（思考折叠 + 工具 + 流式 + Prompt Bar 控制通道）
//   轨迹视图（复用 TrajectoryView 时间线）。
// 数据：comments（user 消息）+ activities（agent 活动流）+ usage（成本）。
// 思考/工具：按回合归组进 Thinking 块（Beautiful UI 移植）—— 推理+工具同回合合并展示。
import { useEffect, useRef, useState } from 'react';
import { useUi, writeHash } from '../store/ui';
import { useProjection, effectiveStatus, waitingLabel, type TaskState } from '../store/projection';
import { listApprovals, decideApproval } from '../api/client';
import { Button } from '../components/Button';
import { TrajectoryView } from './TrajectoryView';
import { Markdown } from '../components/Markdown';
import { Thinking, type ThinkRow } from '../components/Thinking';
import { StreamingText } from '../components/StreamingText';
import { LoadingState } from '../components/LoadingState';
import { PromptBar, type PromptBarHandle, type SlashCommand } from '../components/PromptBar';
import { SelectionActions, promptFromSelection } from '../components/SelectionActions';

type SessionTab = 'chat' | 'trajectory';

/** 把活动流折叠成消息：user 评论；text = agent 正文；think = 一回合的 推理+工具 归组 */
interface Msg {
  id: number;
  kind: 'user' | 'text' | 'think';
  text?: string;
  rows?: ThinkRow[];
  /** 时间戳（epoch ms，排序交错用） */
  at?: number;
}

export function SessionDetailView({ pid, sid }: { pid: string; sid: string }) {
  const cards = useProjection((s) => s.cards);
  const streams = useProjection((s) => s.streams);
  const conn = useProjection((s) => s.conn);
  const toast = useUi((s) => s.toast);
  const [tab, setTab] = useState<SessionTab>('chat');
  const [input, setInput] = useState('');
  const [kbHits, setKbHits] = useState<{ id: string; title: string; summary: string }[]>([]);
  // 会话内切模型（按 sid 持久化；引擎 model 插件经共享文件读取，下一轮生效）
  const [selModel, setSelModel] = useState<string | null>(() => {
    try { return localStorage.getItem('helmsman-session-model:' + sid); } catch { return null; }
  });
  const pickModel = (m: string) => {
    try { localStorage.setItem('helmsman-session-model:' + sid, m); } catch { /* 忽略 */ }
    setSelModel(m);
    void fetch(`/api/sessions/${encodeURIComponent(sid)}/model`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: m }),
    }).catch(() => {});
    toast(`已切换模型 ${m}（下一轮生效）`);
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<PromptBarHandle>(null);

  // 反查归属：卡执行 → card.executions；简单会话 → chats（A 组）
  const cardEntry = Object.entries(cards[pid] ?? {}).find(([, c]) => c.executions[sid]);
  const card = cardEntry?.[1];
  const chats = useProjection((s) => s.chats[pid] || {});
  const task: TaskState | undefined = card?.executions[sid] ?? chats[sid];
  const stream = streams[sid];

  // 返回进入前的视图（openSession 把 view 保留在 URL；不能写死 kanban）
  const back = () => {
    const from = useUi.getState().view;
    writeHash(pid, from === 'home' ? 'kanban' : from, card?.id ?? null, 'comments');
  };

  // 底部锚定（聊天视图）
  useEffect(() => {
    if (tab === 'chat' && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [task?.activities.length, task?.comments?.length, stream, tab]);

  const send = async (raw?: string) => {
    const v = (raw ?? input).trim();
    if (!v) return;
    if (conn !== 'online') { toast('断连期间禁用控制操作'); return; }
    setInput('');
    const ok = await useProjection.getState().postComment(sid, v);
    if (ok) {
      toast('已发送 · 引擎执行中');
      if (card) useProjection.getState().loadCard(card.id);
    } else {
      toast('发送失败');
      setInput(v);
    }
  };

  const searchKb = async (q: string) => {
    if (!q.trim()) { setKbHits([]); return; }
    try {
      const r = await fetch(`/api/kb/search?project=${encodeURIComponent(pid)}&q=${encodeURIComponent(q.trim())}`);
      const rows = (await r.json()) as { id: string; title: string; summary: string }[];
      setKbHits(Array.isArray(rows) ? rows.slice(0, 8) : []);
    } catch { setKbHits([]); }
  };

  // 折叠消息序列：先 user comments，再 agent 活动流（推理/工具按回合归组，正文隔断归组）
  const messages: Msg[] = (() => {
    const msgs: Msg[] = [];
    let n = 0;
    ((task?.comments) ?? []).forEach((c) => {
      if (c.who === 'user') msgs.push({ id: n++, kind: 'user', text: c.text, at: c.at ?? 0 });
    });
    // 工具调用参数索引
    const toolById: Record<string, { args?: string; is_error?: boolean }> = {};
    (task?.tool_calls ?? []).forEach((tc) => { toolById[tc.call_id] = { args: tc.args, is_error: tc.is_error }; });

    let group: ThinkRow[] | null = null;
    const flush = () => {
      if (group && group.length) {
        msgs.push({ id: n++, kind: 'think', rows: group, at: group[0]?.at ?? 0 });
        group = null;
      }
    };

    const acts = task?.activities ?? [];
    let i = 0;
    while (i < acts.length) {
      const a = acts[i];
      if ('Reasoning' in a) {
        if (!group) group = [];
        group.push({ id: n++, kind: 'think', text: a.Reasoning.text, at: a.Reasoning.at ?? 0 });
        i++;
      } else if ('ToolStart' in a) {
        const row: ThinkRow = {
          id: n++,
          kind: 'tool',
          name: a.ToolStart.name,
          args: toolById[a.ToolStart.name]?.args ?? '',
          err: toolById[a.ToolStart.name]?.is_error ?? false,
          at: a.ToolStart.at ?? 0,
        };
        // 合并紧随其后的 ToolResult（耗时/成败）
        let j = i + 1;
        const next = j < acts.length ? acts[j] : null;
        if (next && 'ToolResult' in next) {
          const tr = next.ToolResult;
          const startAt = a.ToolStart.at;
          if (startAt != null && tr.at != null) row.ms = Math.max(0, tr.at - startAt);
          row.err = tr.is_error;
          j++;
        }
        if (!group) group = [];
        group.push(row);
        i = j;
      } else if ('Text' in a) {
        flush();
        msgs.push({ id: n++, kind: 'text', text: a.Text.text, at: a.Text.at ?? 0 });
        i++;
      } else {
        i++;
      }
    }
    flush();
    // 按时间交错（稳定排序：同 turn 的推理/工具/正文相对顺序保持，user 评论落位）
    return msgs.sort((x, y) => (x.at ?? 0) - (y.at ?? 0));
  })();

  const st = task ? effectiveStatus(task) : 'Pending';
  const running = task?.status === 'Running';
  const copyOut = (t: string) => {
    void navigator.clipboard.writeText(t).then(() => toast('已复制')).catch(() => toast('复制失败'));
  };

  // 批复决策：走正式批复 API（队列放行 + 决策记录 + 策略沉淀），不是发评论。
  // 与 TaskDetailDrawer.decideWaiting 同语义（Waiting 放行 = 走队列）。
  const decideWaiting = async (outcome: 'approved' | 'rejected') => {
    if (conn !== 'online') { toast('断连期间禁用控制操作'); return; }
    try {
      const approvals = await listApprovals(pid);
      const appr = approvals.find((a) => a.execution_id === sid && a.outcome === null);
      if (!appr) { toast('未找到待批复项（可能已决策）'); return; }
      const ok = await decideApproval(appr.id, outcome, outcome === 'approved' ? '批准继续' : '需要修改');
      toast(ok ? `已${outcome === 'approved' ? '批准' : '拒绝'} · 决策已送达 agent` : '决策失败');
      if (ok && card) useProjection.getState().loadCard(card.id);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };
  const waitingFollow = task?.waiting ? [
    { id: 'approve', label: '批准继续', onClick: () => { void decideWaiting('approved'); } },
    { id: 'revise', label: '需要修改', onClick: () => { void decideWaiting('rejected'); } },
  ] : undefined;
  const toolSources = messages
    .flatMap((x) => (x.kind === 'think' ? (x.rows ?? []) : []))
    .filter((r) => r.kind === 'tool' && r.name)
    .reduce<{ id: string; label: string }[]>((acc, r) => {
      const label = r.name as string;
      if (!acc.some((s) => s.label === label)) acc.push({ id: String(r.id), label });
      return acc;
    }, []);
  const commands: SlashCommand[] = [
    { id: 'approve', label: '批准继续', hint: '正式批复', run: () => { void decideWaiting('approved'); } },
    { id: 'revise', label: '需要修改', hint: '正式批复', run: () => { void decideWaiting('rejected'); } },
  ];

  return (
    <div id="sessiondetail">
      <header className="sd-head">
        <Button variant="quiet" mini onClick={back} title="返回看板">← 返回</Button>
        <div className="sd-title">
          <strong>{card?.title ?? '会话'}</strong>
          <span className="sd-meta">
            {st === 'Running' ? <span className="dot ok" /> : null}
            {st} · {task?.model ?? '-'} · 回合 {task?.turns ?? 0}
            {task?.waiting ? ` · ⏸ 待批复:${waitingLabel(task.waiting.kind)}` : ''}
          </span>
        </div>
        <div className="sd-tabs">
          {(['chat', 'trajectory'] as SessionTab[]).map((t) => (
            <button key={t} className={'sd-tab' + (tab === t ? ' active' : '')} onClick={() => setTab(t)}>
              {t === 'chat' ? '会话' : '轨迹'}
            </button>
          ))}
        </div>
      </header>

      {tab === 'chat' ? (
        <div className="sd-chat" ref={scrollRef}>
          <SelectionActions
            onAction={(kind, text) => {
              setInput(promptFromSelection(kind, text));
              barRef.current?.focus();
            }}
          >
            {messages.length === 0 && !stream && (
              <div className="ph-empty">
                {running ? <LoadingState variant="orbit" label="引擎思考中…" startedAt={task?.started_at} /> : '暂无消息（引擎执行中或未开始）'}
              </div>
            )}
            {messages.map((m, i) => {
              if (m.kind === 'user') {
                return (
                  <div key={m.id} className="sess-row user">
                    <div className="sess-bub user"><Markdown text={m.text ?? ''} /></div>
                  </div>
                );
              }
              if (m.kind === 'think') {
                return (
                  <div key={m.id} className="sess-row">
                    <Thinking rows={m.rows ?? []} running={running && i === messages.length - 1} />
                  </div>
                );
              }
              const last = i === messages.length - 1;
              return (
                <div key={m.id} className="sess-row">
                  <div className={'sess-bub md-bub' + ((m.text || '').indexOf('失败') === 0 ? ' err' : '')}>
                    <Markdown text={m.text ?? ''} />
                    {last && !stream ? (
                      <StreamingText
                        copyValue={m.text}
                        onCopy={copyOut}
                        sources={toolSources}
                        followups={waitingFollow}
                      />
                    ) : null}
                  </div>
                </div>
              );
            })}
            {!stream && waitingFollow && messages.length > 0 && messages[messages.length - 1].kind !== 'text' ? (
              <div className="sess-row">
                <StreamingText followups={waitingFollow} />
              </div>
            ) : null}
            {stream ? (
              <div className="sess-row">
                <StreamingText text={stream} streaming markdown className="sess-stream" onCopy={copyOut} />
              </div>
            ) : null}
          </SelectionActions>
        </div>
      ) : (
        <div className="sd-traj">
          {task ? <TrajectoryView task={task} stream={stream} /> : <div className="ph-empty">任务未加载</div>}
        </div>
      )}

      <footer className="sd-input">
        <PromptBar
          ref={barRef}
          value={input}
          onChange={setInput}
          onSend={() => void send()}
          placeholder="评论 = 控制通道（指示 / 引导 / 批复）· @ 提及  / 命令"
          disabled={conn !== 'online'}
          mentions={kbHits.map((h) => ({ id: h.id, title: h.title, sub: h.summary?.slice(0, 60) }))}
          onMentionQuery={(q) => void searchKb(q)}
          commands={commands}
          model={selModel || task?.model}
          onModelChange={pickModel}
        />
      </footer>
    </div>
  );
}
