// 职责：命令条（Beautiful UI「Prompt Bar」移植，MIT © Shane Levine）——
//   自适应输入 + @ 源提及 + / 斜杠命令 + 模型芯片 + 语音输入 + 发送。
//   纯展示/输入组件：检索、命令、发送全部经回调上抛；模型芯片只展示当前模型（无切换 API 就不做假下拉）。
import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent, type ReactNode,
} from 'react';

export interface MentionItem {
  id: string | number;
  title: string;
  sub?: string;
}

export interface SlashCommand {
  id: string;
  label: string;
  hint?: string;
  /** 替换 /cmd 为这段文字 */
  insert?: string;
  /** 立刻执行（组件会清掉 /cmd） */
  run?: () => void;
}

export interface PromptBarHandle {
  focus: () => void;
}

interface SpeechRec {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((ev: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}

function speechCtor(): (new () => SpeechRec) | null {
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** 模式 chip 光标图标（InputBar 形态） */
function CursorIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
    </svg>
  );
}

/** 下拉 chevron 图标 */
function ChevronIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="pbar-chip-chev" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

/** 光标前尚未闭合的 @query（忽略已完成的 @[title]） */
export function mentionAt(text: string, caret: number): { start: number; q: string } | null {
  const before = text.slice(0, caret);
  const m = /(?:^|[\s])@([^\s[\]]*)$/.exec(before);
  if (!m) return null;
  return { start: caret - m[1].length - 1, q: m[1] };
}

/** 行首 /cmd */
export function slashAt(text: string, caret: number): { start: number; q: string } | null {
  const before = text.slice(0, caret);
  const m = /(?:^|\n)\/([^\s]*)$/.exec(before);
  if (!m) return null;
  return { start: caret - m[1].length - 1, q: m[1] };
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  placeholder?: string;
  disabled?: boolean;
  busy?: boolean;
  mentions?: MentionItem[];
  /** @query 变化时上抛，调用方负责检索 */
  onMentionQuery?: (q: string) => void;
  mentionEmpty?: string;
  commands?: SlashCommand[];
  /** 当前模型名（只展示；没有切换 API 就不做假 picker） */
  model?: string;
  /** 协作模式名（Agent / Auto 等，只展示） */
  mode?: string;
  /** 工具栏左侧附加动作（提升为任务等） */
  actions?: ReactNode;
  /** 条下方附加（提升表单等） */
  extra?: ReactNode;
  variant?: 'rounded' | 'pill';
}

export const PromptBar = forwardRef<PromptBarHandle, Props>(function PromptBar({
  value,
  onChange,
  onSend,
  placeholder = '问点什么…',
  disabled = false,
  busy = false,
  mentions = [],
  onMentionQuery,
  mentionEmpty = '无命中',
  commands = [],
  model,
  mode = 'Agent',
  actions,
  extra,
  variant = 'rounded',
}, ref) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const rowsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const recRef = useRef<SpeechRec | null>(null);
  const dictBase = useRef('');
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [hl, setHl] = useState<{ top: number; height: number } | null>(null);
  const [listening, setListening] = useState(false);
  const canSpeak = useMemo(() => speechCtor() != null, []);

  useImperativeHandle(ref, () => ({
    focus: () => taRef.current?.focus(),
  }));

  const grow = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }, []);

  useLayoutEffect(() => { grow(); }, [value, grow]);

  const markCaret = () => {
    const el = taRef.current;
    if (el) setCaret(el.selectionStart);
  };

  const mention = mentionAt(value, caret);
  const slash = slashAt(value, caret);

  useEffect(() => {
    if (mention) onMentionQuery?.(mention.q);
  }, [mention?.q]); // eslint-disable-line react-hooks/exhaustive-deps

  const menuItems = (() => {
    if (slash && commands.length) {
      const q = slash.q.toLowerCase();
      return commands
        .filter((c) => !q || c.id.toLowerCase().includes(q) || c.label.toLowerCase().includes(q))
        .map((c) => ({ key: c.id, title: '/' + c.id, sub: c.hint ?? c.label, kind: 'slash' as const, cmd: c }));
    }
    if (mention) {
      return mentions.map((m) => ({ key: String(m.id), title: m.title, sub: m.sub, kind: 'mention' as const, item: m }));
    }
    return [];
  })();

  const menuOpen = slash && commands.length ? true : !!mention;
  const shown = menuItems;

  const glide = (i: number) => {
    const el = rowsRef.current[i];
    if (el) {
      setHl({ top: el.offsetTop, height: el.offsetHeight });
      setActive(i);
    } else {
      setHl(null);
      setActive(0);
    }
  };

  useLayoutEffect(() => {
    if (!menuOpen) { setHl(null); setActive(0); return; }
    glide(Math.min(active, Math.max(0, shown.length - 1)));
    // 仅在菜单内容变化时重定位
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuOpen, shown.length, mention?.q, slash?.q]);

  const replaceRange = (start: number, end: number, insert: string) => {
    const next = value.slice(0, start) + insert + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      const pos = start + insert.length;
      el.focus();
      el.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };

  const pick = (i: number) => {
    const row = shown[i];
    if (!row) return;
    if (row.kind === 'mention' && mention) {
      replaceRange(mention.start, caret, '@[' + row.item.title + '] ');
      return;
    }
    if (row.kind === 'slash' && slash) {
      if (row.cmd.run) {
        replaceRange(slash.start, caret, '');
        row.cmd.run();
      } else if (row.cmd.insert) {
        replaceRange(slash.start, caret, row.cmd.insert);
      }
    }
  };

  const insertToken = (token: string) => {
    const el = taRef.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? start;
    const needsSpace = start > 0 && !/\s$/.test(value.slice(0, start));
    replaceRange(start, end, (needsSpace ? ' ' : '') + token);
  };

  const startDict = () => {
    const Ctor = speechCtor();
    if (!Ctor || listening) {
      recRef.current?.stop();
      return;
    }
    const rec = new Ctor();
    rec.lang = 'zh-CN';
    rec.continuous = true;
    rec.interimResults = true;
    dictBase.current = value;
    rec.onresult = (ev) => {
      let full = '';
      for (let i = 0; i < ev.results.length; i++) full += ev.results[i][0].transcript;
      const base = dictBase.current;
      onChange((base && !/\s$/.test(base) ? base + ' ' : base) + full);
    };
    rec.onerror = () => { setListening(false); recRef.current = null; };
    rec.onend = () => { setListening(false); recRef.current = null; };
    recRef.current = rec;
    setListening(true);
    rec.start();
  };

  useEffect(() => () => { recRef.current?.abort(); }, []);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen && shown.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        glide(Math.min(active + 1, shown.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        glide(Math.max(active - 1, 0));
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        pick(active);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (mention) replaceRange(mention.start, caret, '');
        else if (slash) replaceRange(slash.start, caret, '');
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      recRef.current?.stop();
      if (!disabled && !busy && value.trim()) onSend();
    }
  };

  const sendOk = !disabled && !busy && !!value.trim();

  return (
    <div className={'pbar' + (variant === 'pill' ? ' pill' : '')} data-listening={listening || undefined}>
      {menuOpen ? (
        <div className="pbar-menu" role="listbox">
          {hl ? <span className="pbar-glide" style={{ top: hl.top, height: hl.height, opacity: 1 }} /> : null}
          {shown.map((row, i) => (
            <button
              key={row.key}
              type="button"
              role="option"
              aria-selected={i === active}
              ref={(el) => { rowsRef.current[i] = el; }}
              className="pbar-row"
              onMouseEnter={() => glide(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(i)}
            >
              <span className="pbar-row-t">{row.title}</span>
              {row.sub ? <span className="pbar-row-s">{row.sub}</span> : null}
            </button>
          ))}
          {mention && shown.length === 0 ? (
            <div className="pbar-empty">{mention.q ? mentionEmpty : '输入关键词检索知识库'}</div>
          ) : null}
          {slash && shown.length === 0 ? <div className="pbar-empty">无匹配命令</div> : null}
        </div>
      ) : null}

      <textarea
        ref={taRef}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={placeholder}
        rows={1}
        onChange={(e) => { onChange(e.target.value); setCaret(e.target.selectionStart); }}
        onKeyDown={onKey}
        onKeyUp={markCaret}
        onClick={markCaret}
        onSelect={markCaret}
      />

      <div className="pbar-rowbar">
        <button
          type="button"
          className="pbar-tool"
          title="@ 引用源"
          disabled={disabled}
          onClick={() => { insertToken('@'); }}
        >
          @
        </button>
        {commands.length > 0 ? (
          <button
            type="button"
            className="pbar-tool"
            title="/ 命令"
            disabled={disabled}
            onClick={() => {
              const el = taRef.current;
              const pos = el?.selectionStart ?? value.length;
              const atLine = pos === 0 || value[pos - 1] === '\n';
              insertToken(atLine ? '/' : '\n/');
            }}
          >
            /
          </button>
        ) : null}
        {actions}
        <span className="pbar-spacer" />
        {/* 模式 + 模型下拉 chip（InputBar 形态：左侧选择，右侧发送） */}
        <span className="pbar-chip" title="协作模式">
          <CursorIcon />
          <span>{mode}</span>
          <ChevronIcon />
        </span>
        <span className="pbar-chip" title="当前模型">
          <span className="pbar-chip-model">{model || 'deepseek-v4-flash'}</span>
          <ChevronIcon />
        </span>
        {/* 语音按钮暂隐藏：浏览器原生语音识别对中文/术语准确率不稳，功能不完善不暴露入口
            （保留代码，未来接入可靠识别后置 true 恢复） */}
        {false && canSpeak ? (
          <button
            type="button"
            className={'pbar-tool' + (listening ? ' on' : '')}
            title={listening ? '停止语音' : '语音输入'}
            disabled={disabled}
            aria-pressed={listening}
            onClick={startDict}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <rect x="9" y="2" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
            </svg>
          </button>
        ) : null}
        <button
          type="button"
          className={'pbar-send' + (sendOk ? ' on' : '')}
          disabled={!sendOk}
          title="发送"
          aria-label="发送"
          onClick={() => { recRef.current?.stop(); onSend(); }}
        >
          {busy ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="12" cy="12" r="8" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          )}
        </button>
      </div>
      {extra}
    </div>
  );
});
