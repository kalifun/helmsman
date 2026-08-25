// 职责：会话钻入独立页（O7：`#/p/:pid/t/:sid` 全屏 DSH 式会话）——
//   聊天视图（思考折叠 + 工具 + 流式 + Prompt Bar 控制通道）
//   轨迹视图（复用 TrajectoryView 时间线）。
// 数据：comments（user 消息）+ activities（agent 活动流）+ usage（成本）。
// 思考/工具：按回合归组进 Thinking 块（Beautiful UI 移植）—— 推理+工具同回合合并展示。
import { useEffect, useRef, useState } from 'react';
import { useUi, writeHash } from '../store/ui';
import { useProjection, effectiveStatus, waitingLabel, type TaskState } from '../store/projection';
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
}

export function SessionDetailView({ pid, sid }: { pid: string; sid: string }) {
  const cards = useProjection((s) => s.cards);
  const streams = useProjection((s) => s.streams);
  const conn = useProjection((s) => s.conn);
  const toast = useUi((s) => s.toast);
  const [tab, setTab] = useState<SessionTab>('chat');
  const [input, setInput] = useState('');
  const [kbHits, setKbHits] = useState<{ id: string; title: string; summary: string }[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<PromptBarHandle>(null);

  // 反查归属：卡执行 → card.executions；简单会话 → chats（A 组）
  const cardEntry = Object.entries(cards[pid] ?? {}).find(([, c]) => c.executions[sid]);
  const card = cardEntry?.[1];
  const chats = useProjection((s) => s.chats[pid] || {});
  const task: TaskState | undefined = card?.executions[sid] ?? chats[sid];
  const stream = streams[sid];

  const back = () => writeHash(pid, useUi.getState().view === 'kanban' ? 'kanban' : 'kanban', card?.id ?? null, 'comments');

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
      if (c.who === 'user') msgs.push({ id: n++, kind: 'user', text: c.text });
    });
    // 工具调用参数索引
    const toolById: Record<string, { args?: string; is_error?: boolean }> = {};
    (task?.tool_calls ?? []).forEach((tc) => { toolById[tc.call_id] = { args: tc.args, is_error: tc.is_error }; });

    let group: ThinkRow[] | null = null;
    const flush = () => {
      if (group && group.length) {
        msgs.push({ id: n++, kind: 'think', rows: group });
        group = null;
      }
    };

    const acts = task?.activities ?? [];
    let i = 0;
    while (i < acts.length) {
      const a = acts[i];
      if ('Reasoning' in a) {
        if (!group) group = [];
        group.push({ id: n++, kind: 'think', text: a.Reasoning.text });
        i++;
      } else if ('ToolStart' in a) {
        const row: ThinkRow = {
          id: n++,
          kind: 'tool',
          name: a.ToolStart.name,
          args: toolById[a.ToolStart.name]?.args ?? '',
          err: toolById[a.ToolStart.name]?.is_error ?? false,
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
        msgs.push({ id: n++, kind: 'text', text: a.Text.text });
        i++;
      } else {
        i++;
      }
    }
    flush();
    return msgs;
  })();

  const st = task ? effectiveStatus(task) : 'Pending';
  const running = task?.status === 'Running';
  const commands: SlashCommand[] = [
    { id: 'approve', label: '批准继续', hint: '批复', run: () => { void send('批复：批准继续'); } },
    { id: 'revise', label: '需要修改', hint: '批复', run: () => { void send('批复：需要修改'); } },
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
                {running ? <LoadingState label="引擎思考中…" /> : '暂无消息（引擎执行中或未开始）'}
              </div>
            )}
            {messages.map((m, i) => {
              if (m.kind === 'user') {
                return (
                  <div key={m.id} className="sess-row user">
                    <div className="sess-bub user">{m.text}</div>
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
              return (
                <div key={m.id} className="sess-row">
                  <div className={'sess-bub md-bub' + ((m.text || '').indexOf('失败') === 0 ? ' err' : '')}>
                    <Markdown text={m.text ?? ''} />
                  </div>
                </div>
              );
            })}
            {stream ? (
              <div className="sess-row">
                <StreamingText text={stream} streaming className="sess-stream" />
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
          model={task?.model}
        />
      </footer>
    </div>
  );
}
