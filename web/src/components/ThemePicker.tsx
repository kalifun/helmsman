// 职责：ThemePicker —— 设置里的主题选择器（色板卡网格 + 跟随系统）+ Fine-tune 微调卡（圆角 / 氛围 / 类型）。
// 与原型 renderSettings 的 general 页签一致；主题/氛围/圆角经 localStorage 持久化（ThemeProvider）。
import { THEMES, SYSTEM_THEME_ID } from '../theme/themes';
import { useThemeStore } from '../theme/ThemeProvider';
import { FineTuneCard } from './FineTuneCard';

export function ThemePicker() {
  const themeId = useThemeStore((s) => s.themeId);
  const setTheme = useThemeStore((s) => s.setTheme);

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
      <div style={{ marginTop: 14 }}>
        <FineTuneCard />
      </div>
    </>
  );
}
