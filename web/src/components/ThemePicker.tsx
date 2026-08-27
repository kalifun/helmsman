// 职责：ThemePicker —— 所有主题一个网格（内置 + 导入的自定义），tag 区分来源；选中即应用。
// 概念：没有"皮肤"这个第二类 —— 导入的主题就是主题，只是来源不同（内置/导入）。
// 交互：点任意主题卡 → 应用；内置主题不可删，导入主题可删；主题与自定义互斥（二选一）。
// 次级：界面微调（圆角/氛围）作用于当前主题，见 FineTuneCard。
import { useRef, useState } from 'react';
import { THEMES, SYSTEM_THEME_ID, TK_MAP, type TokenKey, type Theme } from '../theme/themes';
import { useThemeStore } from '../theme/ThemeProvider';
import { activateSkin } from '../theme/ThemeProvider';
import {
  loadSkins, parseSkinJson, parseSkinZip, saveSkin, deleteSkin, loadActiveSkinId,
  type UserSkin,
} from '../theme/skin';
import { FineTuneCard } from './FineTuneCard';
import { WHALE_SKIN, PAPER_SKIN } from '../theme/demo-skins';

/** 自定义主题 → 网格展示形状（复用 Theme 视觉，tag=custom） */
function skinToTheme(s: UserSkin): Theme {
  return {
    id: s.id,
    name: s.name,
    en: [s.tokens ? `tokens ${Object.keys(s.tokens).length}` : '', s.css ? 'css' : '', s.bg ? '背景' : ''].filter(Boolean).join(' · ') || 'custom',
    sw: [
      s.tokens?.canvas ?? s.tokens?.surface ?? '#888',
      s.tokens?.surface ?? s.tokens?.canvas ?? '#888',
      s.tokens?.blue ?? '#888',
    ],
    tag: 'custom',
  };
}

export function ThemePicker() {
  const themeId = useThemeStore((s) => s.themeId);
  const setTheme = useThemeStore((s) => s.setTheme);
  const [skins, setSkins] = useState<Record<string, UserSkin>>(() => loadSkins());
  const [activeSkinId, setActiveSkinId] = useState<string | null>(() => loadActiveSkinId());
  const [msg, setMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = () => {
    setSkins(loadSkins());
    setActiveSkinId(loadActiveSkinId());
  };

  const flash = (text: string) => {
    setMsg(text);
    window.setTimeout(() => setMsg(''), 3000);
  };

  /** 选内置主题 → 停用自定义主题（互斥） */
  const pickTheme = (id: string) => {
    if (activeSkinId) {
      activateSkin(null);
      setActiveSkinId(null);
    }
    setTheme(id);
  };

  /** 选自定义主题 → 激活 */
  const pickSkin = (id: string) => {
    activateSkin(id);
    refresh();
  };

  /** 导出当前外观 → theme.json 下载 */
  const exportTheme = () => {
    const r = document.documentElement.style;
    const tokens: Partial<Record<TokenKey, string>> = {};
    (Object.keys(TK_MAP) as TokenKey[]).forEach((k) => {
      const v = r.getPropertyValue(TK_MAP[k]).trim();
      if (v) tokens[k] = v;
    });
    const data = {
      id: 'export-' + Date.now().toString(36),
      name: '主题导出 ' + new Date().toLocaleDateString(),
      tokens,
      css: '',
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'helmsman-theme.json';
    a.click();
    URL.revokeObjectURL(a.href);
    flash('已导出 theme.json，可导入为自定义主题');
  };

  /** 导入主题（.json 或 .zip）→ 校验 → 存表 → 激活 */
  const importSkin = async (f: File) => {
    let skin: UserSkin | null = null;
    if (f.name.endsWith('.zip')) {
      skin = await parseSkinZip(f);
      if (!skin) { flash('坏 zip 包：需含 theme.css 或 theme.json（css ≤ 512KiB，zip ≤ 2MiB）'); return; }
    } else if (f.name.endsWith('.json')) {
      const text = await f.text();
      skin = parseSkinJson(text);
      if (!skin) { flash('坏 json：需为 { name?, tokens?, css?, bg? }，token 键限 25 键白名单'); return; }
    } else {
      flash('仅支持 .json / .zip');
      return;
    }
    const all = loadSkins();
    // 同名覆盖（更新），新 id 追加
    const existing = Object.values(all).find((s) => s.name === skin!.name);
    const id = existing ? existing.id : skin.id;
    saveSkin({ ...skin, id });
    activateSkin(id);
    refresh();
    flash(`已导入并应用「${skin.name}」`);
  };

  const removeSkin = (id: string) => {
    deleteSkin(id);
    refresh();
    flash('主题已删除');
  };

  /** 一键添加并应用示例主题 */
  const applyDemo = (demo: UserSkin) => {
    saveSkin({ ...demo, createdAt: Date.now() });
    activateSkin(demo.id);
    refresh();
    flash(`已应用「${demo.name}」`);
  };

  const customThemes = Object.values(skins).map(skinToTheme);
  const allThemes: Array<Theme & { isCustom: boolean }> = [
    ...THEMES.map((t) => ({ ...t, isCustom: false })),
    ...customThemes.map((t) => ({ ...t, isCustom: true })),
  ];
  const systemSelected = !activeSkinId && themeId === SYSTEM_THEME_ID;

  return (
    <>
      <div className="set-row">
        <div className="lbl">
          主题
          <div className="desc">内置与导入的主题都在这里，选中即应用</div>
        </div>
      </div>

      <div className="theme-grid">
        {allThemes.map((t) => {
          const selected = t.isCustom ? activeSkinId === t.id : !activeSkinId && themeId === t.id;
          return (
            <button
              key={t.id}
              className={'theme-card' + (selected ? ' sel' : '')}
              onClick={() => (t.isCustom ? pickSkin(t.id) : pickTheme(t.id))}
              title={t.isCustom ? '点击应用（导入的主题）' : '点击应用（内置主题）'}
            >
              <span className="swatches">
                {t.sw.map((c) => <i key={c} style={{ background: c }} />)}
              </span>
              <span className="tn">{t.name}</span>
              <span className="en">{t.en}</span>
              <span className={'tag theme-tag ' + (t.isCustom ? 'custom' : 'builtin')}>
                {t.isCustom ? '导入' : '内置'}
              </span>
              {t.isCustom ? (
                <span className="theme-del" onClick={(e) => { e.stopPropagation(); removeSkin(t.id); }} title="删除主题">×</span>
              ) : null}
            </button>
          );
        })}
        <button className={'theme-card' + (systemSelected ? ' sel' : '')} onClick={() => pickTheme(SYSTEM_THEME_ID)}>
          <span className="swatches">
            <i style={{ background: '#F7F6F3' }} />
            <i style={{ background: '#151412' }} />
          </span>
          <span className="tn">跟随系统</span>
          <span className="en">system</span>
          <span className="tag theme-tag builtin">内置</span>
        </button>
      </div>

      <div className="skin-actions">
        <button className="btn mini" onClick={() => fileRef.current?.click()}>+ 导入主题（json/zip）</button>
        <button className="btn mini ghost" onClick={() => applyDemo(WHALE_SKIN)}>+ 示例 · 鲸</button>
        <button className="btn mini ghost" onClick={() => applyDemo(PAPER_SKIN)}>+ 示例 · 宣纸变装</button>
        <button className="btn mini ghost" onClick={exportTheme}>导出当前</button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,.zip"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importSkin(f);
            e.target.value = '';
          }}
        />
        {msg ? <span className="muted" style={{ marginLeft: 10, fontSize: 12 }}>{msg}</span> : null}
      </div>

      <div style={{ marginTop: 14 }}>
        <FineTuneCard />
      </div>
    </>
  );
}
