// 职责：ThemePicker —— 设置里的主题选择器（色板卡网格 + 跟随系统）+ 皮肤系统（导入/导出/管理）+ Fine-tune。
// 皮肤（Skin System v2）：theme.json（token 子集）+ theme.css（彻底变装）+ background；
// 导入 json/zip → 校验 → localStorage 持久化 → 激活；一键还原 = 回内置主题。
import { useRef, useState } from 'react';
import { THEMES, SYSTEM_THEME_ID, TK_MAP, type TokenKey } from '../theme/themes';
import { useThemeStore } from '../theme/ThemeProvider';
import { activateSkin } from '../theme/ThemeProvider';
import {
  loadSkins, parseSkinJson, parseSkinZip, saveSkin, deleteSkin, loadActiveSkinId,
  type UserSkin,
} from '../theme/skin';
import { FineTuneCard } from './FineTuneCard';
import { WHALE_SKIN, PAPER_SKIN } from '../theme/demo-skins';

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

  /** 导出当前主题 → theme.json 下载（含 25 键当前值，可作皮肤基础） */
  const exportTheme = () => {
    const r = document.documentElement.style;
    const tokens: Partial<Record<TokenKey, string>> = {};
    (Object.keys(TK_MAP) as TokenKey[]).forEach((k) => {
      const v = r.getPropertyValue(TK_MAP[k]).trim();
      if (v) tokens[k] = v;
    });
    const data = {
      id: 'export-' + Date.now().toString(36),
      name: '当前主题导出 ' + new Date().toLocaleDateString(),
      tokens,
      css: '',
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'helmsman-skin.json';
    a.click();
    URL.revokeObjectURL(a.href);
    flash('已导出 theme.json');
  };

  /** 导入皮肤（.json 或 .zip）→ 校验 → 存表 → 激活 */
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
    flash('皮肤已删除');
  };

  /** 一键应用内置示例皮肤（保存到用户皮肤表 + 激活） */
  const applyDemo = (demo: UserSkin) => {
    saveSkin({ ...demo, createdAt: Date.now() });
    activateSkin(demo.id);
    refresh();
    flash(`已应用示例皮肤「${demo.name}」`);
  };

  return (
    <>
      <div className="set-row">
        <div className="lbl">
          主题
          <div className="desc">六套主题 + 跟随系统 + 自定义皮肤</div>
        </div>
      </div>
      <div className="theme-grid">
        {THEMES.map((t) => (
          <button key={t.id} className={'theme-card' + (themeId === t.id ? ' sel' : '')} onClick={() => setTheme(t.id)}>
            <span className="swatches">
              {t.sw.map((c) => <i key={c} style={{ background: c }} />)}
            </span>
            <span className="tn">{t.name}</span>
            <span className="en">{t.en}</span>
          </button>
        ))}
        <button className={'theme-card' + (themeId === SYSTEM_THEME_ID ? ' sel' : '')} onClick={() => setTheme(SYSTEM_THEME_ID)}>
          <span className="swatches">
            <i style={{ background: '#F7F6F3' }} />
            <i style={{ background: '#151412' }} />
          </span>
          <span className="tn">跟随系统</span>
          <span className="en">system</span>
        </button>
      </div>

      {/* 皮肤区：导入 / 导出 / 示例 / 已存皮肤 */}
      <div className="skin-area" style={{ marginTop: 14 }}>
        <div className="skin-actions">
          <button className="btn mini" onClick={exportTheme}>导出当前主题</button>
          <button className="btn mini" onClick={() => fileRef.current?.click()}>导入皮肤（json/zip）</button>
          <button className="btn mini ghost" onClick={() => applyDemo(WHALE_SKIN)}>示例 · 鲸</button>
          <button className="btn mini ghost" onClick={() => applyDemo(PAPER_SKIN)}>示例 · 宣纸变装</button>
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
        {Object.keys(skins).length > 0 ? (
          <div className="skin-list" style={{ marginTop: 8 }}>
            {Object.values(skins).map((s) => (
              <div key={s.id} className={'skin-row' + (activeSkinId === s.id ? ' sel' : '')}>
                <span className="skin-name">{s.name}</span>
                <span className="muted" style={{ fontSize: 11 }}>
                  {s.tokens ? `tokens ${Object.keys(s.tokens).length}` : ''}
                  {s.css ? ' + css' : ''}
                  {s.bg ? ' + bg' : ''}
                </span>
                <div className="skin-ops">
                  <button className="btn mini" onClick={() => { activateSkin(s.id); refresh(); }}>应用</button>
                  {activeSkinId === s.id ? (
                    <button className="btn mini ghost" onClick={() => { activateSkin(null); refresh(); }}>还原内置</button>
                  ) : null}
                  <button className="btn mini ghost" onClick={() => removeSkin(s.id)}>删除</button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div style={{ marginTop: 14 }}>
        <FineTuneCard />
      </div>
    </>
  );
}
