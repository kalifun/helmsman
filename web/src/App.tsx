// 职责：App —— 三段式布局装配 + hash 路由（#pid=&view=&open=&tab=，契约与原型一致）+ WS 订阅。
// 数据流：REST 拉取快照 → 本地投影 → WS 事件防抖刷新（按 last_seq 增量追平）；用户动作 POST → 引擎裁决 → 事件回流。
import { useEffect } from 'react';
import { ThemeProvider, useThemeStore } from './theme/ThemeProvider';
import { Atmosphere } from './theme/Atmosphere';
import { Sidebar } from './components/layout/Sidebar';
import { Topbar } from './components/layout/Topbar';
import { Statusbar } from './components/layout/Statusbar';
import { Toasts } from './components/Toast';
import { NewTaskModal } from './components/modals/NewTaskModal';
import { DirModal } from './components/modals/DirModal';
import { SettingsModal } from './components/modals/SettingsModal';
import { HomeView } from './views/HomeView';
import { ProjectHomeView } from './views/ProjectHomeView';
import { KanbanView } from './views/KanbanView';
import { SessionView } from './views/SessionView';
import { SessionsView } from './views/SessionsView';
import { GraphView } from './views/GraphView';
import { KnowledgeBaseView } from './views/KnowledgeBaseView';
import { FilesView } from './views/FilesView';
import { TaskDetailDrawer } from './views/TaskDetailDrawer';
import { useUi, writeHash, type ViewId, type DrawerTab } from './store/ui';
import { useProjection, refreshTargets } from './store/projection';
import { EventsClient } from './api/events';
import type { IconName } from './components/icons';
import { Button } from './components/Button';
import { ExperimentView } from './views/ExperimentView';
import { ApprovalsView } from './views/ApprovalsView';
import { SessionDetailView } from './views/SessionDetailView';

const VIEW_ITEMS: { id: ViewId; label: string; icon: IconName }[] = [
  { id: 'projhome', label: '首页', icon: 'home' },
  { id: 'kanban', label: '看板', icon: 'board' },
  { id: 'chat', label: '会话', icon: 'chat' },
  { id: 'sessions', label: '会话记录', icon: 'chat' },
  { id: 'graph', label: '图', icon: 'graph' },
  { id: 'kb', label: '知识库', icon: 'kb' },
  { id: 'files', label: '文件', icon: 'folder' },
  { id: 'experiment', label: '实验', icon: 'graph' },
  { id: 'approvals', label: '批复', icon: 'lock' },
];

/** 解析 hash（#pid=&view=&open=&tab= + theme 兼容原型） */
function parseHash() {
  const h = (location.hash || '').slice(1);
  if (!h) return;
  const params: Record<string, string> = {};
  h.split('&').forEach((kv) => {
    const i = kv.indexOf('=');
    if (i > 0) params[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1));
  });
  if (params.theme) useThemeStore.getState().setTheme(params.theme);
  const hashPid = params.pid;
  if (hashPid) {
    const view = params.view && VIEW_ITEMS.some((v) => v.id === params.view) ? (params.view as ViewId) : 'projhome';
    const tab = (['comments', 'brief', 'artifact', 'session', 'trajectory'].includes(params.tab || '')
      ? (params.tab === 'session' ? 'trajectory' : params.tab) : 'comments') as DrawerTab;
    useUi.getState().setRoute({ pid: hashPid, view, openId: params.open || null, tab, sessionId: params.t || null });
    const { pendingProjects } = useUi.getState();
    if (!pendingProjects[hashPid]) useProjection.getState().loadProject(hashPid);
  } else {
    useUi.getState().setRoute({ pid: null, view: 'home', openId: null, tab: 'comments', sessionId: null });
  }
}

function Toolbar({ pid }: { pid: string }) {
  const view = useUi((s) => s.view);
  const setView = (v: ViewId) => {
    useUi.getState().setRoute({ view: v, openId: null, tab: 'comments', sessionId: null });
    writeHash(pid, v, null, 'comments');
  };
  return (
    <div className="toolbar">
      <div className="viewswitch">
        {VIEW_ITEMS.map((v) => (
          <button key={v.id} className={'btn' + (view === v.id ? ' active' : '')} onClick={() => setView(v.id)}>
            {v.label}
          </button>
        ))}
      </div>
      <span className="hint">运行中 / 待确认的卡片锁死，只能通过评论控制</span>
    </div>
  );
}

export default function App() {
  const sideOpen = useUi((s) => s.sideOpen);
  const pid = useUi((s) => s.pid);
  const view = useUi((s) => s.view);
  const openId = useUi((s) => s.openId);
  const sessionId = useUi((s) => s.sessionId);

  // 进入项目 → 主动拉取任务详情（列表/详情分离：列表轻量，激活项目才加载任务）
  useEffect(() => {
    if (!pid) return;
    const { pendingProjects } = useUi.getState();
    if (!pendingProjects[pid]) useProjection.getState().loadProject(pid);
  }, [pid]);
  const revision = useProjection((s) => s.revision);
  const error = useProjection((s) => s.error);

  // 启动：初始拉取 + hash 直达 + WS 订阅（断连指数退避重连，重连后按 last_seq 追平）
  useEffect(() => {
    const boot = async () => {
      await useProjection.getState().loadProjects();
      parseHash();
      const { pid: hp } = useUi.getState();
      if (hp) {
        const { pendingProjects } = useUi.getState();
        if (!pendingProjects[hp]) useProjection.getState().loadProject(hp);
      }
    };
    void boot();

    const client = new EventsClient({
      onEvent: (ev) => useProjection.getState().applyWsEvent(ev),
      onState: (s) => useProjection.getState().setConn(s),
      onReconnect: () => {
        const { pid: p2, openId: o2, view: v2 } = useUi.getState();
        refreshTargets(p2, o2, v2 === 'home');
        useUi.getState().toast('已重连 · last_seq 追平');
      },
    });
    client.connect();
    const onHash = () => parseHash();
    window.addEventListener('hashchange', onHash);
    return () => {
      client.close();
      window.removeEventListener('hashchange', onHash);
    };
  }, []);

  // WS 事件（revision 变化）→ 防抖刷新当前目标（增量追平；不制造循环：load* 不再 bump revision）
  useEffect(() => {
    if (revision === 0) return;
    const t = setTimeout(() => {
      const { pid: p2, openId: o2, view: v2 } = useUi.getState();
      refreshTargets(p2, o2, v2 === 'home');
    }, 400);
    return () => clearTimeout(t);
  }, [revision]);

  const home = view === 'home' || !pid;

  return (
    <ThemeProvider>
      <div className="app">
        <Atmosphere />
        <div id="approw" className={sideOpen ? '' : 'side-off'}>
          <Sidebar />
          <div id="stage">
            <Topbar />
            {pid ? <Toolbar pid={pid} /> : null}
            {error ? (
              <div className="toolbar" style={{ paddingTop: 0 }}>
                <div className="banner err" style={{ marginBottom: 0, flex: 1 }}>
                  {error}
                  <Button mini onClick={() => useProjection.getState().bump()} style={{ marginLeft: 10 }}>重试</Button>
                </div>
              </div>
            ) : null}
            <main className="stage-main">
              {pid && sessionId ? <SessionDetailView pid={pid} sid={sessionId} /> : null}
              {!sessionId && home ? <HomeView /> : null}
              {!sessionId && pid && view === 'projhome' ? <ProjectHomeView pid={pid} /> : null}
              {!sessionId && pid && view === 'kanban' ? <KanbanView pid={pid} /> : null}
              {!sessionId && pid && view === 'chat' ? <SessionView pid={pid} /> : null}
              {!sessionId && pid && view === 'sessions' ? <SessionsView pid={pid} /> : null}
              {!sessionId && pid && view === 'graph' ? <GraphView pid={pid} /> : null}
              {!sessionId && pid && view === 'kb' ? <KnowledgeBaseView pid={pid} /> : null}
              {pid && view === 'files' ? <FilesView pid={pid} /> : null}
              {pid && view === 'experiment' ? <ExperimentView pid={pid} /> : null}
              {pid && view === 'approvals' ? <ApprovalsView pid={pid} /> : null}
              {openId && pid ? <TaskDetailDrawer pid={pid} cardId={openId} /> : null}
            </main>
          </div>
        </div>
        <Statusbar />
        <NewTaskModal />
        <DirModal />
        <SettingsModal />
        <Toasts />
      </div>
    </ThemeProvider>
  );
}