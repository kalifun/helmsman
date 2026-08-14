// 职责：工作台首页 —— 项目列表 + 轻量指标（全部来自 GET /api/projects 自带的状态计数，
// 不加载任务详情）。列表是列表：进入项目才拉取任务（看板/会话记录/首页明细）。
// 指标：任务总数 / 运行中 / 失败 / 完成率（计数聚合）。
import { useUi, writeHash } from '../store/ui';
import { useProjection } from '../store/projection';
import { StatusPill } from '../components/StatusPill';
import { Button } from '../components/Button';
import { Skeleton } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';
import { BrandMark } from '../components/BrandMark';

interface Agg { total: number; pending: number; running: number; done: number; failed: number; cancelled: number }

export function HomeView() {
  const projects = useProjection((s) => s.projects);
  const loading = useProjection((s) => s.loading);
  const setDirOpen = useUi((s) => s.setDirOpen);

  const all = Object.values(projects);
  const agg: Agg = all.reduce(
    (a, p) => {
      const c = p.counts ?? [0, 0, 0, 0, 0];
      return {
        total: a.total + (c[0] + c[1] + c[2] + c[3] + c[4]),
        pending: a.pending + c[0], running: a.running + c[1],
        done: a.done + c[2], failed: a.failed + c[3], cancelled: a.cancelled + c[4],
      };
    },
    { total: 0, pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 },
  );
  const rate = agg.done + agg.failed ? Math.round((agg.done / (agg.done + agg.failed)) * 100) : 100;

  const enter = (pid: string) => {
    useUi.getState().setRoute({ pid, view: 'projhome', openId: null, tab: 'comments' });
    writeHash(pid, 'projhome', null, 'comments');
  };

  if (loading && !all.length) {
    return (
      <div id="home">
        <div className="home-hero"><div><div className="title">工作台</div><div className="sub">跨项目总览</div></div></div>
        <div className="home-grid">
          <div className="home-col"><Skeleton height={120} /><Skeleton height={120} /></div>
          <div className="home-col"><Skeleton height={120} /><Skeleton height={120} /></div>
        </div>
      </div>
    );
  }

  return (
    <div id="home">
      <div className="home-hero">
        <div>
          <div className="title"><BrandMark size={30} className="brand-mark" />工作台</div>
          <div className="sub">
            <span>{all.length} 个项目</span> · <span>{agg.running} 个运行中</span> ·{' '}
            <span className="hot">{agg.failed ? agg.failed + ' 项失败待处理' : '没有需要你处理的任务'}</span>
          </div>
        </div>
        <div className="actions">
          <Button variant="primary" onClick={() => setDirOpen(true)}>新建项目</Button>
        </div>
      </div>

      <div className="home-sec home-metrics">
        <div className="home-sec-t">项目指标</div>
        <div className="metric-grid">
          <div className="metric" style={{ ['--i' as string]: 0 }}>
            <div className="ml">任务完成率</div>
            <div className="mv">{rate}%</div>
            <div className="ms">完成 {agg.done} · 失败 {agg.failed}</div>
          </div>
          <div className="metric" style={{ ['--i' as string]: 1 }}>
            <div className="ml">运行中</div>
            <div className="mv">{agg.running}</div>
            <div className="ms">待办 {agg.pending} · 已取消 {agg.cancelled}</div>
          </div>
          <div className="metric" style={{ ['--i' as string]: 2 }}>
            <div className="ml">任务总数</div>
            <div className="mv">{agg.total}</div>
            <div className="ms">跨 {all.length} 个项目</div>
          </div>
          <div className="metric" style={{ ['--i' as string]: 3 }}>
            <div className="ml">知识沉淀</div>
            <div className="mv">—</div>
            <div className="ms">目标契约 · 接口未开</div>
          </div>
        </div>
      </div>

      <div className="home-grid">
        <div className="home-col">
          <div className="home-sec">
            <div className="home-sec-t">项目</div>
            {all.map((p, k) => {
              const c = p.counts ?? [0, 0, 0, 0, 0];
              const has = (i: number) => c[i] > 0;
              return (
                <div key={p.id} className="home-project" style={{ ['--i' as string]: k }} onClick={() => enter(p.id)}>
                  <div className="row1">
                    <span className="pname">{p.name}</span>
                    <span className="pillrow">
                      {has(1) ? <StatusPill status="Running" label={'运行中 ' + c[1]} /> : null}
                      {has(3) ? <StatusPill status="Failed" label={'失败 ' + c[3]} /> : null}
                      {has(0) ? <StatusPill status="Pending" label={'待办 ' + c[0]} /> : null}
                      {has(2) ? <StatusPill status="Done" label={'完成 ' + c[2]} /> : null}
                      {has(4) ? <StatusPill status="Cancelled" label={'已取消 ' + c[4]} /> : null}
                    </span>
                  </div>
                  <div className="pm">{p.path} · {p.card_count} 张卡</div>
                </div>
              );
            })}
            {!all.length && (
              <EmptyState icon="folder" title="还没有项目" desc="选择目录导入，或建第一张任务卡时自动注册项目" />
            )}
          </div>
          <div className="home-sec">
            <div className="home-sec-t">正在发生</div>
            <div className="ph-empty">{agg.running ? agg.running + ' 个任务运行中（进入项目查看明细）' : '没有正在执行的任务'}</div>
            <div className="ph-hint2">任务明细在进入项目后加载（列表轻量 · 激活才拉详情）</div>
          </div>
        </div>
      </div>
    </div>
  );
}
