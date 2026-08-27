// 职责：ThemePicker —— 主题选择器：内置主题（6 套 + 跟随系统）与自定义主题（互斥单选）。
// 概念：皮肤 = 主题的完全替代（自带完整视觉：色板/字体/背景），选皮肤不再看内置主题颜色。
// 交互：点内置主题 → 自动停用皮肤；点皮肤 → 皮肤激活、主题不高亮。二者单选互斥。
// 皮肤（Skin System v2）：theme.json（token 子集）+ theme.css（彻底变装）+ background；
// 导入 json/zip → 校验 → localStorage 持久化 → 激活；删除皮肤 = 回内置主题。
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

  /** 选内置主题 → 停用皮肤（互斥：皮肤与主题单选） */
  const pickTheme = (id: string) => {
    if (activeSkinId) {
      activateSkin(null);
      setActiveSkinId(null);
    }
    setTheme(id);
  };

  /** 选皮肤 → 激活（主题保持当前内置作基础，但 UI 不高亮主题） */
  const pickSkin = (id: string) => {
    activateSkin(id);
    refresh();
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
    flash('已导出 theme.json（可作自定义主题导入）');
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
    flash('主题已删除');
  };

  /** 一键添加并应用内置示例皮肤 */
  const applyDemo = (demo: UserSkin) => {
    saveSkin({ ...demo, createdAt: Date.now() });
    activateSkin(demo.id);
    refresh();
    flash(`已应用「${demo.name}」`);
  };

  const skinList = Object.values(skins);

  return (
    <>
      <div className="set-row">
        <div className="lbl">
          主题
          <div className="desc">内置主题与自定义主题二选一（自定义主题可含色板/字体/背景）</div>
        </div>
      </div>

      {/* 内置主题网格（皮肤激活时不高亮） */}
      <div className="theme-grid">
        {THEMES.map((t) => (
          <button key={t.id} className={'theme-card' + (!activeSkinId && themeId === t.id ? ' sel' : '')} onClick={() => pickTheme(t.id)}>
            <span className="swatches">
              {t.sw.map((c) => <i key={c} style={{ background: c }} />)}
            </span>
            <span className="tn">{t.name}</span>
            <span className="en">{t.en}</span>
          </button>
        ))}
        <button className={'theme-card' + (!activeSkinId && themeId === SYSTEM_THEME_ID ? ' sel' : '')} onClick={() => pickTheme(SYSTEM_THEME_ID)}>
          <span className="swatches">
            <i style={{ background: '#F7F6F3' }} />
            <i style={{ background: '#151412' }} />
          </span>
          <span className="tn">跟随系统</span>
          <span className="en">system</span>
        </button>
      </div>

      {/* 自定义主题区：与内置主题互斥单选 */}
      <div className="skin-area">
        <div className="skin-head">
          <span className="skin-title">自定义主题</span>
          <span className="muted" style={{ fontSize: 11 }}>导入 / 添加示例 / 导出，选中即应用</span>
        </div>
        {skinList.length > 0 ? (
          <div className="theme-grid">
            {skinList.map((s) => (
              <button key={s.id} className={'theme-card skin-card' + (activeSkinId === s.id ? ' sel' : '')} onClick={() => pickSkin(s.id)} title="点击应用">
                <span className="swatches skin-swatches">
                  {s.tokens ? (
                    <>
                      <i style={{ background: s.tokens.canvas || '#888' }} />
                      <i style={{ background: s.tokens.surface || '#888' }} />
                      <i style={{ background: s.tokens.blue || '#888' }} />
                    </>
                  ) : (
                    <i style={{ background: 'linear-gradient(135deg,#666,#aaa)' }} />
                  )}
                </span>
                <span className="tn">{s.name}</span>
                <span className="en">
                  {s.tokens ? `tokens ${Object.keys(s.tokens).length}` : ''}
                  {s.css ? ' · css' : ''}
                  {s.bg ? ' · 背景' : ''}
                </span>
                <span className="skin-card-ops" onClick={(e) => e.stopPropagation()}>
                  <button className="btn mini ghost" onClick={() => removeSkin(s.id)} title="删除主题">删除</button>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="muted" style={{ fontSize: 12, padding: '6px 0' }}>还没有自定义主题 —— 从示例开始，或导入你的主题包。</div>
        )}
        <div className="skin-actions">
          <button className="btn mini ghost" onClick={() => applyDemo(WHALE_SKIN)}>+ 示例主题 · 鲸</button>
          <button className="btn mini ghost" onClick={() => applyDemo(PAPER_SKIN)}>+ 示例主题 · 宣纸变装</button>
          <button className="btn mini" onClick={() => fileRef.current?.click()}>导入主题（json/zip）</button>
          <button className="btn mini" onClick={exportTheme}>导出当前主题</button>
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
      </div>

      <div style={{ marginTop: 14 }}>
        <FineTuneCard />
      </div>
    </>
  );
}
