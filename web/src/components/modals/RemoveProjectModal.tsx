// 职责：移除项目确认弹窗 —— 两个粒度：仅移除（可恢复，会话归档 + 重新导入恢复）/
// 彻底清理（删 helmsman 侧会话与记录）。用户项目目录/文件在任何模式下都不动。
import { useState } from 'react';
import { Modal } from '../Modal';
import { Button } from '../Button';
import { useUi, writeHash } from '../../store/ui';
import { useProjection } from '../../store/projection';

export function RemoveProjectModal({ pid, name, onClose }: { pid: string; name: string; onClose: () => void }) {
  const removeProject = useProjection((s) => s.removeProject);
  const removePending = useUi((s) => s.removePendingProject);
  const toast = useUi((s) => s.toast);
  const [busy, setBusy] = useState<'archive' | 'purge' | null>(null);

  const doRemove = async (mode: 'archive' | 'purge') => {
    if (busy) return;
    setBusy(mode);
    const ok = await removeProject(pid, mode);
    setBusy(null);
    if (ok) {
      removePending(pid);
      toast(mode === 'archive' ? '已移除（可恢复）· 重新导入同目录即可找回' : '已彻底清理');
      onClose();
      useUi.getState().setRoute({ pid: null, view: 'home', openId: null, tab: 'comments' });
      writeHash(null, 'home', null, 'comments');
    } else {
      toast('移除失败');
    }
  };

  return (
    <Modal open onClose={onClose} wide>
      <div className="set-head">
        <h3>移除项目 · {name}</h3>
        <Button variant="quiet" mini onClick={onClose}>取消</Button>
      </div>
      <div className="set-body">
        <div className="note" style={{ marginBottom: 12 }}>
          两种模式都<b>不会删除你的项目目录和文件</b>，只处理 helmsman 侧数据（任务记录、会话日志、设置）。
        </div>
        <div className="set-row">
          <div className="lbl">
            仅移除（可恢复）
            <div className="desc">从工作台移除；任务会话归档保留，之后重新导入同目录自动恢复</div>
          </div>
          <Button variant="primary" mini disabled={busy !== null} onClick={() => void doRemove('archive')}>
            {busy === 'archive' ? '移除中…' : '仅移除'}
          </Button>
        </div>
        <div className="set-row">
          <div className="lbl">
            彻底清理
            <div className="desc">删除 helmsman 侧的会话日志与记录，不可恢复</div>
          </div>
          <Button variant="ghost" mini disabled={busy !== null} onClick={() => void doRemove('purge')} style={{ color: 'var(--red)' }}>
            {busy === 'purge' ? '清理中…' : '彻底清理'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
