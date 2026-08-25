// 职责：简单会话（两级制松入口，A 组闭环）—— 零成本问答/探索/调研，不进看板。
// 真实引擎：创建独立 ACP 会话（不挂卡）→ 发消息 → 消息流 = user 评论 + agent Text 活动。
// 提升为任务 / 存入知识库 / @知识库检索引用 —— 会话层的三条主路径。
// 面板：Chat + Prompt Bar + Selection Actions（Beautiful UI 移植）。
import { useEffect, useRef, useState } from 'react';
import { useUi, writeHash } from '../store/ui';
import { useProjection, type TaskState } from '../store/projection';
import { Button } from '../components/Button';
import { Icon } from '../components/icons';
import { ToolChips, type ToolChip } from '../components/ToolChips';
import { StreamingText } from '../components/StreamingText';
import { LoadingState } from '../components/LoadingState';
import { Markdown } from '../components/Markdown';
import { ChatPanel } from '../components/ChatPanel';
import { PromptBar, type PromptBarHandle, type SlashCommand } from '../components/PromptBar';
import { SelectionActions, promptFromSelection } from '../components/SelectionActions';

interface KbHit { id: string; title: string; summary: string }

export function SessionView({ pid }: { pid: string }) {
  const chats = useProjection((s) => s.chats[pid] || {});
  const conn = useProjection((s) => s.conn);
  const toast = useUi((s) => s.toast);
  const [sid, setSid] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [kbHits, setKbHits] = useState<KbHit[]>([]);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [promoteTitle, setPromoteTitle] = useState('');
  const areaRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<PromptBarHandle>(null);

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
  const stream = useProjection((s) => (sid ? s.streams[sid] : undefined));

  // 底部锚定
  useEffect(() => {
    if (areaRef.current) areaRef.current.scrollTop = areaRef.current.scrollHeight;
  }, [task?.activities.length, task?.comments?.length, stream]);

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

  const hasThread = !!task?.comments?.length;
  const commands: SlashCommand[] = [
    { id: 'promote', label: '提升为任务', hint: '进看板', run: () => { if (hasThread) setPromoteOpen(true); else toast('先聊几句再提升'); } },
    { id: 'save', label: '存入知识库', hint: 'human-approved', run: () => { if (hasThread) void saveKb(); else toast('先聊几句再保存'); } },
  ];

  // 消息行：user 评论 + agent Text 活动
  const rows: { who: 'user' | 'agent'; text: string }[] = [];
  (task?.comments || []).forEach((c) => rows.push({ who: c.who, text: c.text }));
  (task?.activities || []).forEach((a) => {
    if ('Text' in a && a.Text?.text) rows.push({ who: 'agent', text: a.Text.text });
  });

  // 工具调用汇总（ToolStart 与紧随的 ToolResult 配对 → 折叠 chips）
  const toolCalls: ToolChip[] = (() => {
    const out: ToolChip[] = [];
    const acts = task?.activities ?? [];
    let i = 0;
    while (i < acts.length) {
      const a = acts[i];
      if ('ToolStart' in a) {
        const chip: ToolChip = { id: i, name: a.ToolStart.name, ok: true };
        let j = i + 1;
        const next = j < acts.length ? acts[j] : null;
        if (next && 'ToolResult' in next) {
          const tr = next.ToolResult;
          chip.ok = !tr.is_error;
          const sa = a.ToolStart.at;
          const ta = tr.at;
          if (sa != null && ta != null) chip.ms = Math.max(0, ta - sa);
          j++;
        }
        out.push(chip);
        i = j;
      } else {
        i++;
      }
    }
    return out;
  })();

  const offline = conn !== 'online';
  const copyOut = (t: string) => {
    void navigator.clipboard.writeText(t).then(() => toast('已复制')).catch(() => toast('复制失败'));
  };
  const sources = toolCalls.map((c) => ({ id: c.id, label: c.name }));
  const followups = hasThread ? [
    { id: 'promote', label: '提升为任务', onClick: () => setPromoteOpen(true) },
    { id: 'save', label: '存入知识库', onClick: () => void saveKb() },
  ] : undefined;

  return (
    <div id="chatview">
      <ChatPanel
        bodyRef={areaRef}
        footer={(
          <>
            <PromptBar
              ref={barRef}
              value={input}
              onChange={setInput}
              onSend={() => void send()}
              placeholder="问点什么，或探索这个项目…  @ 引用知识库  / 命令"
              disabled={offline || !sid}
              busy={busy}
              mentions={kbHits.map((h) => ({ id: h.id, title: h.title, sub: h.summary?.slice(0, 60) }))}
              onMentionQuery={(q) => void searchKb(q)}
              commands={commands}
              model={task?.model}
              actions={(
                <>
                  <button type="button" className="pbar-tool" disabled={!hasThread} onClick={() => setPromoteOpen(true)} title="提升为任务">提升</button>
                  <button type="button" className="pbar-tool" disabled={!hasThread} onClick={() => void saveKb()} title="存入知识库">存库</button>
                </>
              )}
              extra={promoteOpen ? (
                <div className="kb-picker">
                  <div className="kb-picker-row">
                    <input value={promoteTitle} onChange={(e) => setPromoteTitle(e.target.value)} placeholder="任务标题（默认取会话首条）" />
                    <Button variant="primary" mini onClick={() => void promote()}>确认提升</Button>
                    <Button variant="quiet" mini onClick={() => setPromoteOpen(false)}>取消</Button>
                  </div>
                </div>
              ) : null}
            />
          </>
        )}
      >
        <SelectionActions
          onAction={(kind, text) => {
            setInput(promptFromSelection(kind, text));
            barRef.current?.focus();
          }}
        >
          {!sid ? (
            <div className="chat-empty">
              <LoadingState variant="dots" label="创建会话中…" />
            </div>
          ) : rows.length === 0 ? (
            <div className="chat-empty">
              <Icon name="chat" className="ic" style={{ width: 26, height: 26, color: 'var(--text3)' }} />
              <div className="t">简单会话</div>
              <div className="d">问答与探索，不进入看板。聊出眉目，可以提升为任务；值得记住的，存入知识库。</div>
            </div>
          ) : (
            rows.map((m, i) => (
              <div key={i} className={'chat-turn ' + m.who}>
                {m.who === 'user' ? (
                  <div className="chat-user">{m.text}</div>
                ) : (
                  <div className="chat-agent">
                    <Markdown text={m.text} />
                    {i === rows.length - 1 && !stream ? (
                      <StreamingText
                        copyValue={m.text}
                        onCopy={copyOut}
                        sources={sources}
                        followups={followups}
                      />
                    ) : null}
                  </div>
                )}
              </div>
            ))
          )}
          {toolCalls.length > 0 ? (
            <div className="chat-turn">
              <ToolChips calls={toolCalls} messages={rows.filter((r) => r.who === 'agent').length} defaultOpen={task?.status === 'Running'} />
            </div>
          ) : null}
          {stream ? (
            <div className="chat-turn">
              <StreamingText text={stream} streaming sources={sources} onCopy={copyOut} />
            </div>
          ) : null}
        </SelectionActions>
      </ChatPanel>
    </div>
  );
}
