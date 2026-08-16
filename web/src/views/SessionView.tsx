// 职责：简单会话（两级制松入口，A 组闭环）—— 零成本问答/探索/调研，不进看板。
// 真实引擎：创建独立 ACP 会话（不挂卡）→ 发消息 → 消息流 = user 评论 + agent Text 活动。
// 提升为任务 / 存入知识库 / @知识库检索引用 —— 会话层的三条主路径。
import { useEffect, useRef, useState } from 'react';
import { useUi, writeHash } from '../store/ui';
import { useProjection, type TaskState } from '../store/projection';
import { Button } from '../components/Button';
import { Icon } from '../components/icons';

interface KbHit { id: string; title: string; summary: string }

export function SessionView({ pid }: { pid: string }) {
  const chats = useProjection((s) => s.chats[pid] || {});
  const conn = useProjection((s) => s.conn);
  const toast = useUi((s) => s.toast);
  const [sid, setSid] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [kbOpen, setKbOpen] = useState(false);
  const [kbQuery, setKbQuery] = useState('');
  const [kbHits, setKbHits] = useState<KbHit[]>([]);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [promoteTitle, setPromoteTitle] = useState('');
  const areaRef = useRef<HTMLDivElement>(null);

  // 首次挂载创建会话；之后轮询刷新
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!sid) {
        const newSid = await useProjection.getState().createChat(pid);
        if (alive && newSid) {
          setSid(newSid);
          await useProjection.getState().loadChat(newSid, pid);
        }
      }
    })();
    const timer = setInterval(() => { if (sid && alive) void useProjection.getState().loadChat(sid, pid); }, 2500);
    return () => { alive = false; clearInterval(timer); };
  }, [pid, sid]);

  const task: TaskState | undefined = sid ? chats[sid] : undefined;

  // 底部锚定
  useEffect(() => {
    if (areaRef.current) areaRef.current.scrollTop = areaRef.current.scrollHeight;
  }, [task?.activities.length, task?.comments?.length]);

  const send = async () => {
    const v = input.trim();
    if (!v || busy || !sid) return;
    if (conn !== 'online') { toast('断连期间禁用控制操作'); return; }
    setBusy(true);
    setInput('');
    const ok = await useProjection.getState().sendChat(sid, v);
    setBusy(false);
    if (!ok) toast('发送失败，见错误横幅');
  };

  const searchKb = async (q: string) => {
    if (!q.trim()) { setKbHits([]); return; }
    try {
      const r = await fetch(`/api/kb/search?project=${encodeURIComponent(pid)}&q=${encodeURIComponent(q.trim())}`);
      const rows = (await r.json()) as KbHit[];
      setKbHits(Array.isArray(rows) ? rows.slice(0, 8) : []);
    } catch { setKbHits([]); }
  };

  const promote = async () => {
    if (!sid) return;
    const cardId = await useProjection.getState().promoteChat(sid, { title: promoteTitle.trim() || undefined });
    if (cardId) {
      toast('已提升为任务：上下文进简报，引擎自动执行');
      setPromoteOpen(false);
      writeHash(pid, 'kanban', cardId, 'comments');
      setSid(null);
      setInput('');
    } else {
      toast('提升失败，见错误横幅');
    }
  };

  const saveKb = async () => {
    if (!sid) return;
    const ok = await useProjection.getState().saveChatToKb(sid);
    toast(ok ? '已存入知识库（human-approved）' : '存入失败，见错误横幅');
  };

  // 消息行：user 评论 + agent Text 活动
  const rows: { who: 'user' | 'agent'; text: string }[] = [];
  (task?.comments || []).forEach((c) => rows.push({ who: c.who, text: c.text }));
  (task?.activities || []).forEach((a) => {
    if ('Text' in a && a.Text?.text) rows.push({ who: 'agent', text: a.Text.text });
  });

  return (
    <div id="chatview">
      <div className="chat-area" ref={areaRef}>
        {!sid ? (
          <div className="chat-empty">
            <Icon name="chat" className="ic" style={{ width: 26, height: 26, color: 'var(--text3)' }} />
            <div className="t">创建会话中…</div>
          </div>
        ) : rows.length === 0 ? (
          <div className="chat-empty">
            <Icon name="chat" className="ic" style={{ width: 26, height: 26, color: 'var(--text3)' }} />
            <div className="t">简单会话</div>
            <div className="d">问答与探索，不进入看板。聊出眉目，可以提升为任务；值得记住的，存入知识库。</div>
          </div>
        ) : (
          rows.map((m, i) => (
            <div key={i} className={'chat-msg ' + (m.who === 'user' ? 'mine' : 'theirs')}>
              <div className="bub" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.text}</div>
              <div className="meta">{m.who === 'user' ? '你' : 'agent'} · {i + 1}</div>
            </div>
          ))
        )}
        {task?.status === 'Running' && rows.length > 0 ? <div className="chat-typing">agent 思考中…</div> : null}
      </div>
      <div className="chat-bar">
        <div className="composer">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="问点什么，或探索这个项目…（@ 知识库插入引用）"
            aria-label="会话输入"
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
          />
          <div className="composer-row">
            <Button variant="quiet" mini onClick={() => { setKbOpen((v) => !v); if (!kbOpen) setKbHits([]); }}>@ 知识库</Button>
            <Button variant="quiet" mini onClick={() => setPromoteOpen(true)} disabled={!task?.comments?.length}>提升为任务</Button>
            <Button variant="quiet" mini onClick={() => void saveKb()} disabled={!task?.comments?.length}>存入知识库</Button>
            <span className="kbd">Enter 发送</span>
            <span className="spacer" />
            <Button variant="primary" mini onClick={() => void send()} disabled={busy || !input.trim()}>发送</Button>
          </div>
          {kbOpen ? (
            <div className="kb-picker">
              <div className="kb-picker-row">
                <input
                  value={kbQuery}
                  onChange={(e) => { setKbQuery(e.target.value); void searchKb(e.target.value); }}
                  placeholder="检索项目知识库…"
                  autoFocus
                />
              </div>
              {kbHits.map((h) => (
                <button
                  key={h.id}
                  className="kb-hit"
                  onClick={() => { setInput((v) => `${v}@[${h.title}]`.trim()); setKbOpen(false); }}
                  title={h.summary}
                >
                  <span className="kb-hit-t">{h.title}</span>
                  <span className="kb-hit-s">{h.summary?.slice(0, 60)}</span>
                </button>
              ))}
              {kbQuery && kbHits.length === 0 ? <div className="muted" style={{ padding: 6, fontSize: 12 }}>无命中</div> : null}
            </div>
          ) : null}
          {promoteOpen ? (
            <div className="kb-picker">
              <div className="kb-picker-row">
                <input value={promoteTitle} onChange={(e) => setPromoteTitle(e.target.value)} placeholder="任务标题（默认取会话首条）" />
                <Button variant="primary" mini onClick={() => void promote()}>确认提升</Button>
                <Button variant="quiet" mini onClick={() => setPromoteOpen(false)}>取消</Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
