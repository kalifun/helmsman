// 职责：设置模态 —— 通用（主题）/ 预设（Profile 三轴管理，真实 API）/ 模型 / 插件 / MCP / Skills。
// 预设页签真实生效（listProfiles / setDefaultProfile / createProfile）；其余页签为只读演示。
import { useEffect, useState } from 'react';
import { Modal } from '../Modal';
import { Button } from '../Button';
import { Switch } from '../Switch';
import { ThemePicker } from '../ThemePicker';
import { useUi } from '../../store/ui';
import {
  listProfiles, setDefaultProfile, createProfile, deleteProfile, profileSummary,
  MODE_LABEL, SETTING_LABEL, APPROVAL_LABEL, SANDBOX_LABEL,
  type Profile,
} from '../../api/client';

type TabId = 'general' | 'presets' | 'model' | 'plugins' | 'mcp' | 'skills';

const TABS: { id: TabId; label: string }[] = [
  { id: 'general', label: '通用' },
  { id: 'presets', label: '预设' },
  { id: 'model', label: '模型' },
  { id: 'plugins', label: '插件' },
  { id: 'mcp', label: 'MCP' },
  { id: 'skills', label: 'Skills' },
];

function SettingRow({ label, desc, children }: { label: string; desc?: string; children?: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="lbl">{label}{desc ? <div className="desc">{desc}</div> : null}</div>
      {children}
    </div>
  );
}

/** 预设管理页签：Profile 列表 + 三轴 + 设默认 + 自定义（§2.6 项目级管理）。 */
function PresetTab({ pid }: { pid: string | null }) {
  const toast = useUi((s) => s.toast);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [mode, setMode] = useState<Profile['mode']>('normal');
  const [setting, setSetting] = useState<Profile['setting']>('balanced');
  const [approval, setApproval] = useState<Profile['approval']>('ask');
  const [sandbox, setSandbox] = useState<Profile['sandbox']>('workspace-write');

  const load = () => {
    if (!pid) return;
    void listProfiles(pid).then(setProfiles).catch(() => setProfiles([]));
  };
  useEffect(load, [pid]);

  const makeDefault = async (id: string) => {
    if (!pid) return;
    const ok = await setDefaultProfile(pid, id);
    toast(ok ? `已设「${profiles.find((p) => p.id === id)?.name ?? id}」为项目默认` : '设置默认失败');
    if (ok) load();
  };

  const create = async () => {
    if (!pid || !newId.trim() || !newName.trim()) { toast('id 和 name 必填'); return; }
    const p = await createProfile(pid, { id: newId.trim(), name: newName.trim(), mode, setting, approval, sandbox });
    toast(p ? `已创建预设「${p.name}」` : '创建失败（id 冲突或格式不对）');
    if (p) { setNewId(''); setNewName(''); load(); }
  };

  const remove = async (id: string, name: string) => {
    if (!pid) return;
    const ok = await deleteProfile(pid, id);
    toast(ok ? `已删除「${name}」` : '删除失败（内置不能删）');
    if (ok) load();
  };

  return (
    <>
      <SettingRow label="项目预设（Profile）" desc="三轴组合 = 命名预设；首个预设 = 项目默认（§2.6）" />
      {profiles.map((p) => (
        <SettingRow key={p.id} label={`${p.name}${p.is_default ? ' ★' : ''}${p.is_builtin ? ' · 内置' : ''}`} desc={profileSummary(p)}>
          <span style={{ display: 'flex', gap: 6 }}>
            <Button mini variant="ghost" disabled={p.is_default} onClick={() => void makeDefault(p.id)} title={`设「${p.name}」为默认`}>设默认</Button>
            {!p.is_builtin && (
              <Button mini variant="ghost" onClick={() => void remove(p.id, p.name)} title={`删除「${p.name}」`}>删除</Button>
            )}
          </span>
        </SettingRow>
      ))}
      <div className="preset-custom">
        <div className="preset-custom-head">
          <span className="lbl">自定义预设</span>
          <span className="desc">复制现有三轴存新预设（内置不可覆盖，用新 id）</span>
        </div>
        <div className="preset-form">
          <div className="preset-form-row">
            <input placeholder="id（小写连字符，如 my-plan）" value={newId} onChange={(e) => setNewId(e.target.value)} />
            <input placeholder="显示名（如 我的计划流）" value={newName} onChange={(e) => setNewName(e.target.value)} />
          </div>
          <div className="preset-axes">
            <select value={mode} onChange={(e) => setMode(e.target.value as Profile['mode'])} title="协作方式">
              {(Object.keys(MODE_LABEL) as Profile['mode'][]).map((k) => <option key={k} value={k}>方式·{MODE_LABEL[k]}</option>)}
            </select>
            <select value={setting} onChange={(e) => setSetting(e.target.value as Profile['setting'])} title="执行设定">
              {(Object.keys(SETTING_LABEL) as Profile['setting'][]).map((k) => <option key={k} value={k}>设定·{SETTING_LABEL[k]}</option>)}
            </select>
            <select value={approval} onChange={(e) => setApproval(e.target.value as Profile['approval'])} title="审批姿态">
              {(Object.keys(APPROVAL_LABEL) as Profile['approval'][]).map((k) => <option key={k} value={k}>审批·{APPROVAL_LABEL[k]}</option>)}
            </select>
            <select value={sandbox} onChange={(e) => setSandbox(e.target.value as Profile['sandbox'])} title="沙箱">
              {(Object.keys(SANDBOX_LABEL) as Profile['sandbox'][]).map((k) => <option key={k} value={k}>沙箱·{SANDBOX_LABEL[k]}</option>)}
            </select>
            <Button mini variant="primary" onClick={() => void create()}>创建预设</Button>
          </div>
        </div>
      </div>
    </>
  );
}

export function SettingsModal() {
  const open = useUi((s) => s.settingsOpen);
  const setOpen = useUi((s) => s.setSettingsOpen);
  const pid = useUi((s) => s.pid);
  const toast = useUi((s) => s.toast);
  const [tab, setTab] = useState<TabId>('general');

  const body = (() => {
    if (tab === 'general') return <ThemePicker />;
    if (tab === 'presets') return <PresetTab pid={pid} />;
    if (tab === 'model') return (
      <>
        <SettingRow label="默认分层" desc="难回合自动升级 pro（§6.3 · 目标契约）">
          <select defaultValue="auto"><option>flash</option><option>auto</option><option>pro</option></select>
        </SettingRow>
        <SettingRow label="升级阈值" desc="失败信号 ≥ N 次升级剩余回合">
          <input type="number" defaultValue={3} min={1} max={10} />
        </SettingRow>
        <SettingRow label="定价表" desc="输入 ¥2 / 输出 ¥8 / 缓存读 ¥0.2 / 思考 ¥8（每 M token）" />
      </>
    );
    if (tab === 'plugins') return (
      <>
        {[
          ['知识库', 'SQLite 双时态边失效 + 检索'],
          ['任务编排', 'DAG 调度 · 拓扑执行 · 局部重跑'],
          ['执行经济学', 'cache-first 前缀分区 · 成本计量'],
          ['工具修复', 'scavenge / truncation / flatten'],
        ].map(([name, desc]) => (
          <SettingRow key={name} label={name} desc={desc}>
            <Switch checked onChange={() => toast('插件开关为目标契约（P0 未开）')} />
          </SettingRow>
        ))}
      </>
    );
    if (tab === 'mcp') return (
      <>
        {([
          ['github', '仓库与 PR 操作', 12],
          ['filesystem', '本地文件读写', 8],
        ] as [string, string, number][]).map(([name, desc, n]) => (
          <SettingRow key={name} label={name} desc={desc}>
            <span className={'set-badge ' + (n ? 'on' : 'off')}>{n} 工具</span>
          </SettingRow>
        ))}
        <div className="set-add">
          <Button mini onClick={() => toast('添加 MCP 服务器 = 目标契约（P0 未开）')}>添加 MCP 服务器</Button>
        </div>
      </>
    );
    return (
      <>
        {['find-skills', 'gitnexus-cli', 'dsh-prose-standard'].map((name) => (
          <SettingRow key={name} label={name} desc="目标契约 · P0 未开">
            <Switch checked onChange={() => toast('Skills 开关为目标契约（P0 未开）')} />
          </SettingRow>
        ))}
      </>
    );
  })();

  return (
    <Modal open={open} onClose={() => setOpen(false)} wide>
      <div className="set-head">
        <h3>设置</h3>
        <Button variant="quiet" mini onClick={() => setOpen(false)}>关闭</Button>
      </div>
      <div className="set-tabs">
        {TABS.map((t) => (
          <button key={t.id} className={'set-tab' + (tab === t.id ? ' active' : '')} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="set-body">{body}</div>
    </Modal>
  );
}