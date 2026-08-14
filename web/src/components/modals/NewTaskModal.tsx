// 职责：建卡模态（M2.3，O1=B）—— 卡 = 资产：目标（一句话）+ 类型（需求/缺陷/任务）+
// 需求描述（卡 description）+ 里程碑（属性，P1 筛选）+ 备注 + 预设 Profile（三轴组合）+
// 依赖（目标契约 taskgraph：完成本卡前需先完成的卡）。
// POST /api/projects/:pid/cards {title, description, kind, milestone, preset_id, deps}：建卡即自动跑首代执行。
import { useEffect, useState } from 'react';
import { Modal } from '../Modal';
import { Button } from '../Button';
import { useUi } from '../../store/ui';
import { useProjection, cardStatus } from '../../store/projection';
import { listProfiles, MODE_LABEL, SETTING_LABEL, APPROVAL_LABEL, SANDBOX_LABEL, type Profile } from '../../api/client';
import { StatusPill } from '../StatusPill';

const KINDS: { value: string; label: string }[] = [
  { value: 'requirement', label: '需求' },
  { value: 'bug', label: '缺陷' },
  { value: 'task', label: '任务' },
];

export function NewTaskModal() {
  const open = useUi((s) => s.newTaskOpen);
  const setOpen = useUi((s) => s.setNewTaskOpen);
  const pid = useUi((s) => s.pid);
  const toast = useUi((s) => s.toast);
  const createCard = useProjection((s) => s.createCard);

  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('task');
  const [presetId, setPresetId] = useState('');
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [description, setDescription] = useState('');
  const [milestone, setMilestone] = useState('');
  const [note, setNote] = useState('');
  const [depIds, setDepIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const cards = useProjection((s) => (pid ? s.cards[pid] || {} : {}));
  const depOptions = Object.values(cards).sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));

  // 打开时加载项目 Profile（默认项预填 —— 用户可见，§2.6"建卡预填"）
  useEffect(() => {
    if (!open || !pid) return;
    void listProfiles(pid).then((ps) => {
      setProfiles(ps);
      const def = ps.find((p) => p.is_default);
      setPresetId(def ? def.id : '');
    }).catch(() => setProfiles([]));
  }, [open, pid]);

  const submit = async () => {
    if (!pid || !title.trim() || busy) return;
    setBusy(true);
    // 备注并入描述（首条上下文；卡 = 资产，描述 = 需求描述）
    const desc = note.trim() ? (description.trim() ? `${description.trim()}

备注：${note.trim()}` : `备注：${note.trim()}`) : description.trim();
    const cardId = await createCard(pid, {
      title: title.trim(),
      description: desc,
      kind,
      milestone: milestone.trim() || undefined,
      preset: presetId || undefined,
      deps: depIds.length ? depIds : undefined,
    });
    setBusy(false);
    if (cardId) {
      toast('卡已创建，引擎自动跑首代执行');
      setOpen(false);
      setTitle('');
      setKind('task');
      setDescription('');
      setMilestone('');
      setNote('');
      setDepIds([]);
    } else {
      toast('创建失败，见错误横幅');
    }
  };

  return (
    <Modal open={open} onClose={() => setOpen(false)}>
      <h3>新建卡（资产）</h3>
      <div className="field">
        <label>目标</label>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="一句话描述需求/缺陷"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) submit(); }}
        />
      </div>
      <div className="field">
        <label>类型</label>
        <div className="kind-opts">
          {KINDS.map((k) => (
            <span
              key={k.value}
              className={'kind-opt' + (kind === k.value ? ' active' : '')}
              onClick={() => setKind(k.value)}
            >{k.label}</span>
          ))}
        </div>
      </div>
      <div className="field">
        <label>里程碑（可选 · P1 筛选维度，属性现在就存）</label>
        <input
          value={milestone}
          onChange={(e) => setMilestone(e.target.value)}
          placeholder="如 v0.2"
        />
      </div>
      <div className="field">
        <label>预设 Profile（三轴组合 · 策略可见）</label>
        <select value={presetId} onChange={(e) => setPresetId(e.target.value)}>
          {profiles.map((p) => (
            <option key={p.id} value={p.id} title={`${MODE_LABEL[p.mode]} · ${SETTING_LABEL[p.setting]} · ${APPROVAL_LABEL[p.approval]} · 沙箱 ${SANDBOX_LABEL[p.sandbox]}`}>
              {p.name}{p.is_default ? '（默认）' : ''}
            </option>
          ))}
        </select>
        <div className="ph-hint2" style={{ marginTop: 4 }}>预设 = 协作方式 × 执行设定 × 审批姿态 · 沙箱（悬停选项看明细；执行启动时快照，不改）。</div>
      </div>
      <div className="field">
        <label>依赖（可选 · 完成本卡前需先完成；图上画边）</label>
        {depOptions.length === 0 ? (
          <div className="ph-hint2" style={{ padding: '6px 0' }}>项目还没有卡 —— 先建无依赖的卡，图会按依赖分层。</div>
        ) : (
          <div style={{ maxHeight: 130, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', padding: 4 }}>
            {depOptions.map((c) => {
              const st = cardStatus(c);
              const checked = depIds.includes(c.id);
              return (
                <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 6px', fontSize: 12.5, cursor: 'pointer', borderRadius: 4 }}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => setDepIds((prev) => (e.target.checked ? [...prev, c.id] : prev.filter((d) => d !== c.id)))}
                  />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</span>
                  <StatusPill status={st as never} />
                </label>
              );
            })}
          </div>
        )}
      </div>
      <div className="field">
        <label>需求描述</label>
        <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="可选：验收标准/约束/上下文（P1 需求校准流程会细化）" />
      </div>
      <div className="field">
        <label>备注（作为首条执行上下文）</label>
        <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="可选" />
      </div>
      <div className="modal-actions">
        <Button variant="quiet" onClick={() => setOpen(false)}>取消</Button>
        <Button variant="primary" disabled={!title.trim() || busy} onClick={submit}>创建并执行</Button>
      </div>
    </Modal>
  );
}
