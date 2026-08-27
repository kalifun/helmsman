// 职责：Topbar —— 侧栏折叠钮 + logo + 面包屑 + 连接点 + 建卡/跑全部（项目内）。
// 连接点：在线绿 / 断连·重连中橙（闪烁）/ 离线灰；断连期间禁用控制类操作（建卡）。
import { useUi, writeHash } from '../../store/ui';
import { useProjection } from '../../store/projection';
import { Icon } from '../icons';
import { Button } from '../Button';

const VIEW_LABEL: Record<string, string> = {
  projhome: '首页', kanban: '看板', chat: '会话',
  sessions: '会话记录', graph: '图', kb: '知识库', files: '文件', metrics: '度量',
};

export function Topbar() {
  const pid = useUi((s) => s.pid);
  const view = useUi((s) => s.view);
  const toggleSide = useUi((s) => s.toggleSide);
  const setNewTaskOpen = useUi((s) => s.setNewTaskOpen);
  const projects = useProjection((s) => s.projects);
  const conn = useProjection((s) => s.conn);
  const pending = useUi((s) => s.pendingProjects);
  const toast = useUi((s) => s.toast);

  const inProject = !!pid;
  const proj = pid ? projects[pid] ?? pending[pid] : null;
  const online = conn === 'online';

  const connText = conn === 'online' ? `服务在线 · ${Object.keys(projects).length} 项目` : conn === 'reconnect' ? '断连 · 重连中' : '服务不可达';

  const breadcrumb = !inProject ? (
    <b>工作台</b>
  ) : (
    <>
      <a
        onClick={() => {
          useUi.getState().setRoute({ pid: null, view: 'home', openId: null, tab: 'comments', sessionId: null });
          writeHash(null, 'home', null, 'comments');
        }}
      >
        项目
      </a>
      <span className="sep">/</span>
      <b>{proj?.name ?? pid}</b>
      {view !== 'projhome' && view !== 'home' ? (
        <>
          <span className="sep">/</span>
          <span>{VIEW_LABEL[view]}</span>
        </>
      ) : null}
    </>
  );

  return (
    <header className="topbar">
      <Button variant="icon" aria-label="折叠侧栏" title="折叠侧栏" onClick={toggleSide}>
        <Icon name="side" size="sm" />
      </Button>
      {/* 进入项目后不显示 logo：面包屑的「项目」即可回工作台，避免 logo/面包屑重复占位 */}
      <div id="breadcrumb">{breadcrumb}</div>
      <div className="spacer" />
      <div id="conn" data-state={conn}>
        <span className="dot" />
        <span id="conn-text">{connText}</span>
      </div>
      {inProject ? (
        <>
          <Button
            className={inProject ? '' : 'hidden'}
            disabled={!online}
            title={online ? undefined : '断连期间禁用控制操作'}
            onClick={() => {
              if (!pid) return;
              useUi.getState().setRoute({ openId: null, sessionId: null });
              setNewTaskOpen(true);
            }}
          >
            <Icon name="plus" size="sm" />建卡
          </Button>
          <Button variant="primary" className={inProject ? '' : 'hidden'} disabled={!online} onClick={() => {
            toast('任务创建即自动执行；如无新任务可点此刷新');
            useProjection.getState().bump();
          }}>
            <Icon name="play" size="sm" />跑全部
          </Button>
        </>
      ) : null}
    </header>
  );
}