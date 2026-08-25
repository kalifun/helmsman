// 职责：微调卡（Beautiful UI「Fine-tune Card」移植，MIT © Shane Levine）——
//   界面 inspector：圆角 / 氛围透明度 / 主题类型。全部写入 ThemeStore（localStorage），不是假滑杆。
import { THEMES, SYSTEM_THEME_ID } from '../theme/themes';
import { useThemeStore, type AtmoLevel } from '../theme/ThemeProvider';

const ATMO: { v: AtmoLevel; n: number; label: string }[] = [
  { v: 'off', n: 0, label: '关' },
  { v: 'soft', n: 33, label: '淡' },
  { v: 'on', n: 66, label: '标准' },
  { v: 'strong', n: 100, label: '浓' },
];

function atmoOf(n: number): AtmoLevel {
  if (n < 17) return 'off';
  if (n < 50) return 'soft';
  if (n < 83) return 'on';
  return 'strong';
}

export function FineTuneCard() {
  const themeId = useThemeStore((s) => s.themeId);
  const setTheme = useThemeStore((s) => s.setTheme);
  const atmo = useThemeStore((s) => s.atmo);
  const setAtmo = useThemeStore((s) => s.setAtmo);
  const radius = useThemeStore((s) => s.radius);
  const setRadius = useThemeStore((s) => s.setRadius);
  const atmoN = ATMO.find((x) => x.v === atmo)?.n ?? 66;

  return (
    <div className="ftune">
      <div className="ftune-head">
        <span className="ftune-title">界面</span>
        <span className="ftune-adj">调整</span>
      </div>
      <div className="ftune-body">
        <div className="ftune-row">
          <span className="ftune-k">圆角</span>
          <input
            type="range"
            min={4}
            max={16}
            value={radius}
            aria-label="圆角"
            onChange={(e) => setRadius(Number(e.target.value))}
          />
          <span className="ftune-n">{radius}</span>
        </div>
        <div className="ftune-row">
          <span className="ftune-k">氛围</span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={atmoN}
            aria-label="氛围强度"
            onChange={(e) => setAtmo(atmoOf(Number(e.target.value)))}
          />
          <span className="ftune-n">{ATMO.find((x) => x.v === atmo)?.label}</span>
        </div>
        <div className="ftune-row">
          <span className="ftune-k">类型</span>
          <select value={themeId} aria-label="主题" onChange={(e) => setTheme(e.target.value)}>
            {THEMES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            <option value={SYSTEM_THEME_ID}>跟随系统</option>
          </select>
        </div>
      </div>
    </div>
  );
}
