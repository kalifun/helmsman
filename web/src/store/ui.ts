// 职责：UI 路由/导航 store —— 三段式导航状态 + 模态开关 + toast。
// hash 路由契约与原型一致： #pid=&view=&open=&tab= （view: home|projhome|kanban|chat|graph|kb|files）。
import { create } from 'zustand';

export type ViewId = 'home' | 'projhome' | 'kanban' | 'chat' | 'sessions' | 'graph' | 'kb' | 'files' | 'experiment' | 'approvals';
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
  sideOpen: boolean;
  sideQ: string;
  settingsOpen: boolean;
  newTaskOpen: boolean;
  dirOpen: boolean;
  /** 本地待注册项目（离线兜底；刷新持久化。服务端显式注册后移除） */
  pendingProjects: Record<string, { id: string; name: string; path: string }>;
  toasts: ToastItem[];
  setRoute: (p: Partial<Pick<UiState, 'pid' | 'view' | 'openId' | 'tab'>>) => void;
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

/** 把当前路由写入 hash（契约：#pid=&view=&open=&tab=） */
export function writeHash(pid: string | null, view: ViewId, openId: string | null, tab: DrawerTab) {
  const params: string[] = [];
  if (pid) params.push('pid=' + encodeURIComponent(pid));
  if (view && view !== 'home') params.push('view=' + view);
  if (openId) params.push('open=' + encodeURIComponent(openId));
  if (tab && tab !== 'comments') params.push('tab=' + tab);
  const h = params.length ? '#' + params.join('&') : '#';
  if (location.hash !== h) history.replaceState(null, '', h);
}