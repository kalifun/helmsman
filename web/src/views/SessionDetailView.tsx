// 职责：会话钻入独立页（O7：`#/p/:pid/t/:sid` 全屏 DSH 式会话）——
//   聊天视图（消息气泡 + 思考折叠 + 工具调用 + 流式 + 输入框=评论控制通道）
//   轨迹视图（复用 TrajectoryView 时间线）。
// 数据：comments（user 消息）+ activities（agent 活动流）+ usage（成本）。
import { useEffect, useRef, useState } from 'react';
import { useUi, writeHash } from '../store/ui';
import { useProjection, effectiveStatus, waitingLabel, type TaskState } from '../store/projection';
import { Button } from '../components/Button';
import { TrajectoryView } from './TrajectoryView';
import { Markdown } from '../components/Markdown';

type SessionTab = 'chat' | 'trajectory';

/** 把活动流折叠成消息气泡（user 已由 comments 表达；agent 的 Text/Reasoning/Tool 各自成块） */
interface Msg {
  id: number;
  kind: 'user' | 'agent-text' | 'agent-think' | 'tool';
  text?: string;
  name?: string;
  args?: string;
  err?: boolean;
  ms?: number;
}

export function SessionDetailView({ pid, sid }: { pid: string; sid: string }) {
  const cards = useProjection((s) => s.cards);
  const streams = useProjection((s) => s.streams);
  const conn = useProjection((s) => s.conn);
  const toast = useUi((s) => s.toast);
  const [tab, setTab] = useState<SessionTab>('chat');
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

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

  const send = async () => {
    const v = input.trim();
    if (!v) return;
    if (conn !== 'online') { toast('断连期间禁用控制操作'); return; }
    setInput('');
    const ok = await useProjection.getState().postComment(sid, v);
    if (ok) {
      toast('已发送 · 引擎执行中');
      if (card) useProjection.getState().loadCard(card.id);
    } else {
      toast('发送失败');
    }
  };

  // 折叠消息序列：先 user comments，再 agent 活动流
  const messages: Msg[] = (() => {
    const msgs: Msg[] = [];
    let n = 0;
    ((task?.comments) ?? []).forEach((c) => {
      if (c.who === 'user') msgs.push({ id: n++, kind: 'user', text: c.text });
    });
    // 工具调用参数索引
    const toolById: Record<string, { args?: string; is_error?: boolean }> = {};
    (task?.tool_calls ?? []).forEach((tc) => { toolById[tc.call_id] = { args: tc.args, is_error: tc.is_error }; });
    (task?.activities ?? []).forEach((a) => {
      if ('Reasoning' in a) msgs.push({ id: n++, kind: 'agent-think', text: a.Reasoning.text });
      else if ('Text' in a) msgs.push({ id: n++, kind: 'agent-text', text: a.Text.text });
      else if ('ToolStart' in a) {
        msgs.push({
          id: n++, kind: 'tool', name: a.ToolStart.name,
          args: toolById[a.ToolStart.name]?.args ?? '',
          err: toolById[a.ToolStart.name]?.is_error ?? false,
        });
      }
    });
    return msgs;
  })();

  const st = task ? effectiveStatus(task) : 'Pending';

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
          {messages.length === 0 && !stream && <div className="ph-empty">暂无消息（引擎执行中或未开始）</div>}
          {messages.map((m) => {
            if (m.kind === 'user') {
              return (
                <div key={m.id} className="sess-row user">
                  <div className="sess-bub user">{m.text}</div>
                </div>
              );
            }
            if (m.kind === 'agent-think') {
              return (
                <details key={m.id} className="sess-think">
                  <summary>💭 思考</summary>
                  <div className="think-body">{m.text}</div>
                </details>
              );
            }
            if (m.kind === 'tool') {
              return (
                <div key={m.id} className="sess-row">
                  <div className="sess-tool">
                    <span className="tool-name">⚙ {m.name}</span>
                    <span className={m.err ? 'err' : 'ok'}>{m.err ? '失败' : '成功'}</span>
                    {m.ms != null ? <span className="muted">{m.ms} ms</span> : null}
                  </div>
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
              <div className="sess-bub dim">▌ {stream}</div>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="sd-traj">
          {task ? <TrajectoryView task={task} stream={stream} /> : <div className="ph-empty">任务未加载</div>}
        </div>
      )}

      <footer className="sd-input">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="评论 = 控制通道（指示 / 引导 / 批复）· Enter 发送"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
        />
        <Button variant="primary" disabled={!input.trim() || conn !== 'online'} onClick={() => void send()}>发送</Button>
      </footer>
    </div>
  );
}
