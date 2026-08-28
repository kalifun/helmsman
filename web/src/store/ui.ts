// 职责：UI 路由/导航 store —— 三段式导航状态 + 模态开关 + toast。
// hash 路由契约与原型一致： #pid=&view=&open=&tab= （view: home|projhome|kanban|chat|graph|kb|files）。
import { create } from 'zustand';

export type ViewId = 'home' | 'projhome' | 'kanban' | 'chat' | 'sessions' | 'graph' | 'kb' | 'files' | 'metrics' | 'experiment' | 'approvals';
export type DrawerTab = 'comments' | 'brief' | 'artifact' | 'trajectory';

interface ToastItem {
  id: number;
  msg: string;
}

interface UiState {
  pid: string | null;
  view: ViewId;
  openId: string | null;
  tab: DrawerTab;
  /** 会话钻入全屏页：session id（hash `t=` 参数；非空 = 渲染 SessionDetailView） */
  sessionId: string | null;
  sideOpen: boolean;
  sideQ: string;
  settingsOpen: boolean;
  newTaskOpen: boolean;
  dirOpen: boolean;
  /** 本地待注册项目（离线兜底；刷新持久化。服务端显式注册后移除） */
  pendingProjects: Record<string, { id: string; name: string; path: string }>;
  toasts: ToastItem[];
  setRoute: (p: Partial<Pick<UiState, 'pid' | 'view' | 'openId' | 'tab' | 'sessionId'>>) => void;
  toggleSide: () => void;
  setSideQ: (q: string) => void;
  setSettingsOpen: (v: boolean) => void;
  setNewTaskOpen: (v: boolean) => void;
  setDirOpen: (v: boolean) => void;
  addPendingProject: (id: string, name: string, path: string) => void;
  removePendingProject: (id: string) => void;
  openDetail: (sid: string, tab?: DrawerTab) => void;
  closeDetail: () => void;
  toast: (msg: string) => void;
  dismissToast: (id: number) => void;
}

let toastSeq = 1;

export const useUi = create<UiState>((set, get) => ({
  pid: null,
  view: 'home',
  openId: null,
  tab: 'comments',
  sessionId: null,
  sideOpen: (() => { try { return localStorage.getItem('helmsman-side') !== '0'; } catch { return true; } })(),
  sideQ: '',
  settingsOpen: false,
  newTaskOpen: false,
  dirOpen: false,
  pendingProjects: (() => {
    try { return JSON.parse(localStorage.getItem('helmsman-pending') || '{}'); } catch { return {}; }
  })(),
  toasts: [],

  setRoute: (p) => set((s) => ({ ...s, ...p })),
  toggleSide: () => {
    const v = !get().sideOpen;
    try { localStorage.setItem('helmsman-side', v ? '1' : '0'); } catch { /* ignore */ }
    set({ sideOpen: v });
  },
  setSideQ: (q) => set({ sideQ: q }),
  setSettingsOpen: (v) => set({ settingsOpen: v }),
  setNewTaskOpen: (v) => set({ newTaskOpen: v }),
  setDirOpen: (v) => set({ dirOpen: v }),
  addPendingProject: (id, name, path) => set((s) => {
    const pendingProjects = { ...s.pendingProjects, [id]: { id, name, path } };
    try { localStorage.setItem('helmsman-pending', JSON.stringify(pendingProjects)); } catch { /* ignore */ }
    return { pendingProjects };
  }),
  removePendingProject: (id) => set((s) => {
    const pendingProjects = { ...s.pendingProjects };
    delete pendingProjects[id];
    try { localStorage.setItem('helmsman-pending', JSON.stringify(pendingProjects)); } catch { /* ignore */ }
    return { pendingProjects };
  }),
  openDetail: (sid, tab) => set({ openId: sid, tab: tab || 'comments' }),
  closeDetail: () => set({ openId: null }),
  toast: (msg) => {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts, { id, msg }] }));
    setTimeout(() => get().dismissToast(id), 2800);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** 把当前路由写入 hash（契约：#pid=&view=&open=&tab=&t=） */
export function writeHash(pid: string | null, view: ViewId, openId: string | null, tab: DrawerTab, sessionId?: string | null) {
  const params: string[] = [];
  if (pid) params.push('pid=' + encodeURIComponent(pid));
  if (view && view !== 'home') params.push('view=' + view);
  if (openId) params.push('open=' + encodeURIComponent(openId));
  if (tab && tab !== 'comments') params.push('tab=' + tab);
  if (sessionId) params.push('t=' + encodeURIComponent(sessionId));
  const h = params.length ? '#' + params.join('&') : '#';
  // 必须触发 hashchange（App 监听它 parseHash → 更新 store → 重渲染）：
  // history.replaceState 只改地址栏不触发事件，是"点返回没反应"的根因。
  if (location.hash !== h) location.hash = h;
}

/** 跳会话钻入全屏页：#pid=&t=<sid>（保留 view 以便返回） */
export function openSession(pid: string, sid: string, view: ViewId, cardId: string | null) {
  useUi.getState().setRoute({ sessionId: sid, openId: cardId, pid });
  writeHash(pid, view, cardId, 'comments', sid);
}