// 职责：对话面板（Beautiful UI「Chat」移植，MIT © Shane Levine）——
//   顶栏分页签 + 消息流 + 底部 composer。推理/工具/流式由调用方塞进 children。
// 激活 tab 支持操作菜单：改名（✎ 或菜单项）/ 分叉会话 / 归档会话。
import { useEffect, useRef, useState } from 'react';
import type { ReactNode, Ref } from 'react';

export interface ChatTab {
  id: string;
  label: string;
  /** 改名：输入框提交 */
  onRename?: (id: string, title: string) => void;
  /** 分叉会话（复制历史为新会话） */
  onFork?: (id: string) => void;
  /** 归档会话（移出列表） */
  onArchive?: (id: string) => void;
}

interface Props {
  tabs?: ChatTab[];
  tab?: string;
  onTab?: (id: string) => void;
  children: ReactNode;
  footer: ReactNode;
  bodyRef?: Ref<HTMLDivElement>;
}

export function ChatPanel({ tabs, tab, onTab, children, footer, bodyRef }: Props) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [menuId, setMenuId] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // 点外部关闭菜单
  useEffect(() => {
    if (!menuId) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuId(null);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menuId]);

  // 打开菜单：记录按钮 viewport 坐标，菜单 fixed 定位（脱离 overflow 裁剪）
  // 自适应边界：右对齐会超出视口左侧时改为左对齐；底部空间不足时向上弹
  const openMenu = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (menuId === id) { setMenuId(null); return; }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const MENU_W = 128;
    const MENU_H = 104;
    let x = rect.right - MENU_W; // 右对齐
    if (x < 4) x = rect.left;     // 左边界不足 → 左对齐
    if (x + MENU_W > window.innerWidth - 4) x = window.innerWidth - MENU_W - 4; // 右边界不足
    let y = rect.bottom + 4;
    if (y + MENU_H > window.innerHeight - 4) y = rect.top - MENU_H - 4; // 底部不足 → 向上弹
    setMenuPos({ x, y });
    setMenuId(id);
  };

  const commitRename = (id: string) => {
    const v = draft.trim();
    setRenamingId(null);
    if (!v) return;
    const t = tabs?.find((x) => x.id === id);
    t?.onRename?.(id, v);
  };

  return (
    <div className="chatpanel">
      {tabs && tabs.length > 0 ? (
        <div className="chatpanel-tabs">
          {tabs.map((t) => {
            const active = t.id === tab;
            const renaming = active && renamingId === t.id;
            return (
              <span key={t.id} className={'chatpanel-tab' + (active ? ' active' : '')}>
                {renaming ? (
                  <input
                    className="chatpanel-tab-edit"
                    value={draft}
                    autoFocus
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(t.id);
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                    onBlur={() => commitRename(t.id)}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <>
                    <button type="button" className="chatpanel-tab-label" onClick={() => onTab?.(t.id)}>
                      {t.label}
                    </button>
                    {active && (t.onRename || t.onFork || t.onArchive) ? (
                      <span className="chatpanel-tab-actions">
                        <button
                          type="button"
                          className={'chatpanel-tab-btn' + (menuId === t.id ? ' open' : '')}
                          title="更多操作"
                          onClick={(e) => openMenu(t.id, e)}
                        >
                          ⋮
                        </button>
                      </span>
                    ) : null}
                  </>
                )}
              </span>
            );
          })}
        </div>
      ) : null}
      <div className="chatpanel-body" ref={bodyRef}>{children}</div>
      <div className="chatpanel-foot">{footer}</div>
      {menuId !== null && menuPos ? (
        <div
          className="chatpanel-tab-menu"
          ref={menuRef}
          style={{ position: 'fixed', left: menuPos.x, top: menuPos.y, right: 'auto' }}
          onClick={(e) => e.stopPropagation()}
        >
          <button type="button" className="chatpanel-tab-menu-item" onClick={() => { setMenuId(null); const t = tabs?.find((x) => x.id === menuId); if (t) { setDraft(t.label.replace(/…$/, '')); setRenamingId(t.id); } }}>
            改标题
          </button>
          <button
            type="button"
            className="chatpanel-tab-menu-item"
            onClick={() => { const t = tabs?.find((x) => x.id === menuId); setMenuId(null); t?.onFork?.(t.id); }}
          >
            分叉会话
          </button>
          <button
            type="button"
            className="chatpanel-tab-menu-item danger"
            onClick={() => { const t = tabs?.find((x) => x.id === menuId); setMenuId(null); t?.onArchive?.(t.id); }}
          >
            归档会话
          </button>
        </div>
      ) : null}
    </div>
  );
}
