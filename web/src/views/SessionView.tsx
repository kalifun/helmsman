// 职责：简单会话（两级制松入口）—— 零成本问答/探索/调研，不进看板。
// 占位：消息流 + 悬浮胶囊输入条；提升为任务 / 存入知识库 = 目标契约（标注不假实现）。
// 会话记录（项目全部会话清单）在「会话记录」视图。
import { useState } from 'react';
import { useUi } from '../store/ui';
import { Button } from '../components/Button';
import { Icon } from '../components/icons';

interface ChatMsg { who: 'user' | 'agent'; text: string }

export function SessionView({ pid }: { pid: string }) {
  const [log, setLog] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const toast = useUi((s) => s.toast);
  const setNewTaskOpen = useUi((s) => s.setNewTaskOpen);

  const send = () => {
    const v = input.trim();
    if (!v) return;
    setLog((l) => [...l, { who: 'user', text: v }]);
    setInput('');
    setTimeout(() => setLog((l) => [...l, { who: 'agent', text: '（P0 占位）简单会话引擎未接入。聊出眉目可提升为任务。' }]), 500);
  };

  return (
    <div id="chatview">
      <div className="chat-area">
        {log.length === 0 ? (
          <div className="chat-empty">
            <Icon name="chat" className="ic" style={{ width: 26, height: 26, color: 'var(--text3)' }} />
            <div className="t">简单会话</div>
            <div className="d">问答与探索，不进入看板。聊出眉目，可以提升为任务；值得记住的，存入知识库。</div>
            <div className="a">
              <Button mini onClick={() => toast('提升为任务 = 目标契约（会话上下文进简报 · P0 未开）')}>提升为任务</Button>
              <Button mini onClick={() => toast('存入知识库 = 目标契约（KbNote · P0 未开）')}>存入知识库</Button>
            </div>
          </div>
        ) : (
          log.map((m, i) => (
            <div key={i} className={'chat-msg ' + (m.who === 'user' ? 'mine' : 'theirs')}>
              <div className="bub">{m.text}</div>
              <div className="meta">{m.who === 'user' ? '你' : 'agent'} · {i + 1}</div>
            </div>
          ))
        )}
      </div>
      <div className="chat-bar">
        <div className="composer">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="问点什么，或探索这个项目…"
            aria-label="会话输入"
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          />
          <div className="composer-row">
            <select className="model-sel" title="会话模型" aria-label="会话模型" defaultValue="auto">
              <option value="auto">auto</option>
              <option value="flash">flash</option>
              <option value="pro">pro</option>
            </select>
            <Button variant="quiet" mini onClick={() => toast('@知识库 = 目标契约（检索引用 · P1）')}>@ 知识库</Button>
            <span className="kbd">Enter 发送</span>
            <span className="spacer" />
            <Button variant="quiet" mini onClick={() => setNewTaskOpen(true)}>提升为任务</Button>
            <Button variant="quiet" mini onClick={() => toast('存入知识库 = 目标契约（KbNote · P0 未开）')}>存入知识库</Button>
            <Button variant="primary" mini onClick={send}>发送</Button>
          </div>
        </div>
      </div>
      <span className="hidden">{pid}</span>
    </div>
  );
}
