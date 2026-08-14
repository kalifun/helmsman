// 职责：ThemePicker —— 设置里的主题选择器（色板卡网格 + 跟随系统）+ 氛围档位（关闭/淡/标准/浓）。
// 与原型 renderSettings 的 general 页签一致；主题/氛围经 localStorage 持久化（ThemeProvider）。
import { THEMES, SYSTEM_THEME_ID } from '../theme/themes';
import { useThemeStore, type AtmoLevel } from '../theme/ThemeProvider';

const ATMO_LEVELS: { v: AtmoLevel; label: string }[] = [
  { v: 'off', label: '关闭' },
  { v: 'soft', label: '淡' },
  { v: 'on', label: '标准' },
  { v: 'strong', label: '浓' },
];

export function ThemePicker() {
  const themeId = useThemeStore((s) => s.themeId);
  const setTheme = useThemeStore((s) => s.setTheme);
  const atmo = useThemeStore((s) => s.atmo);
  const setAtmo = useThemeStore((s) => s.setAtmo);

  return (
    <>
      <div className="set-row">
        <div className="lbl">
          主题
          <div className="desc">六套主题 + 跟随系统</div>
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
      <div className="set-row" style={{ marginTop: 14 }}>
        <div className="lbl">
          背景氛围
          <div className="desc">每套主题的氛围层：光晕 / 星空 / 光斑</div>
        </div>
        <select value={atmo} onChange={(e) => setAtmo(e.target.value as AtmoLevel)}>
          {ATMO_LEVELS.map((x) => (
            <option key={x.v} value={x.v}>{x.label}</option>
          ))}
        </select>
      </div>
    </>
  );
}
