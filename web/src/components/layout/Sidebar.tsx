// 职责：Sidebar —— 项目列表（两行：名称 + 状态小字统计 / 状态点 / 折叠 / 筛选输入）+ 新建项目 + 设置入口。
// 状态点：运行蓝 > 待确认黄 > 空闲灰；统计：运行中/失败/完成；busy 计数徽标。侧栏折叠由 App 控制 #approw.side-off。
import { useMemo } from 'react';
import { useUi, writeHash } from '../../store/ui';
import { useProjection, cardStatus, type Project } from '../../store/projection';
import { Icon } from '../icons';
import { BrandMark } from '../BrandMark';

export function Sidebar() {
  const pid = useUi((s) => s.pid);
  const sideQ = useUi((s) => s.sideQ);
  const setSideQ = useUi((s) => s.setSideQ);
  const setSettingsOpen = useUi((s) => s.setSettingsOpen);
  const setDirOpen = useUi((s) => s.setDirOpen);
  const projects = useProjection((s) => s.projects);
  const cards = useProjection((s) => s.cards);
  const pending = useUi((s) => s.pendingProjects);

  const list = useMemo(() => {
    const q = sideQ.trim().toLowerCase();
    const reg = Object.values(projects).map((p) => ({ ...p, pending: false as boolean }));
    const pen = Object.values(pending).map((p) => ({ id: p.id, name: p.name, path: p.path, card_count: 0, counts: undefined as Project['counts'], pending: true as boolean }));
    return [...reg, ...pen]
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  }, [projects, pending, sideQ]);

  return (
    <aside id="sidebar">
      <div className="side-brand">
        <div className="app-badge"><BrandMark size={24} /></div>
        <b>Helmsman</b>
      </div>
      <div className="side-filter">
        <Icon name="search" size="sm" />
        <input value={sideQ} onChange={(e) => setSideQ(e.target.value)} placeholder="筛选项目" aria-label="筛选项目" />
      </div>
      <div className="side-label">项目</div>
      <div id="side-projects">
        {list.length === 0 && <div className="side-empty">无匹配项目</div>}
        {list.map((p, k) => {
          const c = p.counts
            ? { Pending: p.counts[0], Running: p.counts[1], Done: p.counts[2], Failed: p.counts[3], Cancelled: p.counts[4] }
            : cardCountsLocal(Object.values(cards[p.id] || {}));
          const active = p.id === pid;
          const dotColor = c.Running > 0 ? 'var(--blue)' : '';
          const stats: string[] = [];
          if (c.Running) stats.push(c.Running + ' 运行中');
          if (c.Failed) stats.push(c.Failed + ' 失败');
          if (c.Done) stats.push(c.Done + ' 完成');
          if (p.pending) stats.push('待注册');
          const busy = c.Running;
          return (
            <div
              key={p.id}
              className={'side-item' + (active ? ' active' : '')}
              style={{ ['--i' as string]: k }}
              onClick={() => {
                useUi.getState().setRoute({ pid: p.id, view: 'projhome', openId: null, tab: 'comments' });
                writeHash(p.id, 'projhome', null, 'comments');
              }}
            >
              <span className="sdot" style={dotColor ? { background: dotColor } : undefined} />
              <div className="side-main">
                <div className="sname">{p.name}{p.pending ? <span style={{ fontSize: 10, color: 'var(--blue)', marginLeft: 6 }}>新</span> : null}</div>
                <div className="sstats">{stats.join(' · ') || '空闲'}</div>
              </div>
              {busy ? <span className="scount">{busy}</span> : null}
            </div>
          );
        })}
      </div>
      <div className="side-foot">
        <button className="side-new" onClick={() => setDirOpen(true)}>
          <Icon name="plus" size="sm" />新建项目
        </button>
        <button className="side-set" onClick={() => setSettingsOpen(true)}>
          <Icon name="gear" size="sm" />设置
        </button>
      </div>
    </aside>
  );
}

/** 卡计数（按卡的最新执行状态；无执行 = Pending）—— 服务端 counts 缺失时的本地兜底 */
function cardCountsLocal(cards: import('../../store/projection').CardState[]): { Pending: number; Running: number; Done: number; Failed: number; Cancelled: number } {
  const out = { Pending: 0, Running: 0, Done: 0, Failed: 0, Cancelled: 0 };
  cards.forEach((c) => {
    const st = cardStatus(c);
    if (st === 'Pending' || st === 'Running' || st === 'Done' || st === 'Failed' || st === 'Cancelled') out[st] += 1;
  });
  return out;
}