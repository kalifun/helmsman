// 职责：新建项目模态 —— 「选择目录…」调服务端 POST /api/fs/pick（osascript 弹系统「选择文件夹」
// 对话框），服务端直接返回绝对路径 → 自动填路径 + 项目名 → 创建。无枚举、无反查、无浏览器上传语义。
// 路径/项目名均可手动改（兜底）；离线/注册失败落 pending（持久化）。
import { useEffect, useState } from 'react';
import { Modal } from '../Modal';
import { Button } from '../Button';
import { useUi, writeHash } from '../../store/ui';
import { useProjection } from '../../store/projection';
import { pickFs } from '../../api/client';
import { Icon } from '../icons';

function baseName(path: string): string {
  const p = path.trim().replace(/\/+$/, '');
  return p.split('/').filter(Boolean).pop() || p;
}

export function DirModal() {
  const open = useUi((s) => s.dirOpen);
  const setOpen = useUi((s) => s.setDirOpen);
  const addPending = useUi((s) => s.addPendingProject);
  const removePending = useUi((s) => s.removePendingProject);
  const pending = useUi((s) => s.pendingProjects);
  const toast = useUi((s) => s.toast);
  const registerProject = useProjection((s) => s.registerProject);
  const projects = useProjection((s) => s.projects);
  const conn = useProjection((s) => s.conn);

  const [pathInput, setPathInput] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [nameEdited, setNameEdited] = useState(false);

  useEffect(() => {
    if (!open) return;
    setBusy(false); setName(''); setPathInput(''); setNameEdited(false);
  }, [open]);

  // 系统「选择文件夹」对话框（服务端弹，直接返回绝对路径）
  const pickDir = async () => {
    setPicking(true);
    try {
      const r = await pickFs();
      if (r.cancelled) return;
      if (r.path) {
        setPathInput(r.path);
        if (!nameEdited) setName(baseName(r.path));
        toast('已选择：' + r.path);
      }
    } catch (e) {
      toast('无法弹出目录选择器：' + (e instanceof Error ? e.message : String(e)).slice(0, 80));
    } finally {
      setPicking(false);
    }
  };

  const enter = (id: string, n: string, p: string) => {
    setOpen(false);
    useUi.getState().setRoute({ pid: id, view: 'projhome', openId: null, tab: 'comments' });
    writeHash(id, 'projhome', null, 'comments');
    void n; void p;
  };

  const create = async () => {
    const p = pathInput.trim();
    const n = name.trim() || baseName(p);
    if (!p || busy) return;
    setBusy(true);

    const existing = Object.values(projects).find((x) => x.name === n || x.path === p);
    if (existing) {
      removePending(existing.id);
      setBusy(false);
      toast('项目已存在，直接进入');
      enter(existing.id, existing.name, existing.path);
      return;
    }
    if (conn === 'online') {
      const proj = await registerProject(p, n);
      if (proj) {
        setBusy(false);
        removePending(proj.id);
        toast('项目已创建');
        enter(proj.id, proj.name, proj.path);
        return;
      }
    }
    const id = n.toLowerCase().replace(/[^a-zA-Z0-9_-]/g, '-') || 'project';
    addPending(id, n, p);
    setBusy(false);
    toast(conn === 'online' ? '注册失败 · 已保存为待注册项目' : '离线模式 · 已保存，建卡时注册');
    enter(id, n, p);
  };

  const existingIds = new Set(Object.values(projects).map((p) => p.id));
  const pendingList = Object.values(pending).filter((p) => !existingIds.has(p.id));

  return (
    <Modal open={open} onClose={() => setOpen(false)} wide>
      <div className="set-head">
        <h3>新建项目</h3>
        <Button variant="quiet" mini onClick={() => setOpen(false)}>关闭</Button>
      </div>
      <div className="set-body">
        <div className="field">
          <label>选择项目目录</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Button variant="primary" onClick={() => void pickDir()} disabled={picking}>
              <Icon name="folder" size="sm" />{picking ? '等待选择…' : '选择目录…'}
            </Button>
            <span style={{ fontSize: 11.5, color: 'var(--text3)' }}>弹出系统「选择文件夹」对话框</span>
          </div>
        </div>
        <div className="field" style={{ marginTop: 8 }}>
          <label>目录路径（选择后自动填充 · 可改）</label>
          <input
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            placeholder="选择目录后自动填充，或手动输入"
            onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
          />
        </div>
        <div className="field">
          <label>项目名（自动取目录名）</label>
          <input
            value={name}
            onChange={(e) => { setNameEdited(true); setName(e.target.value); }}
            onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
          />
        </div>
        {pendingList.length ? (
          <div className="note" style={{ marginTop: 8 }}>
            待注册：{pendingList.map((p) => <span key={p.id} className="linkchip" onClick={() => enter(p.id, p.name, p.path)}>{p.name}</span>)}
          </div>
        ) : null}
        <div className="modal-actions" style={{ marginTop: 14 }}>
          <Button variant="quiet" onClick={() => setOpen(false)}>取消</Button>
          <Button variant="primary" disabled={!pathInput.trim() || busy} onClick={() => void create()}>
            {busy ? '创建中…' : '创建项目'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
