// 职责：微调卡（Beautiful UI「Fine-tune Card」移植，MIT © Shane Levine）——
//   对当前主题的微调：圆角 / 氛围透明度。全部写入 ThemeStore（localStorage），不是假滑杆。
//   主题选择已并入 ThemePicker 网格（内置 + 导入统一列表），此处不再重复"类型"下拉。
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
  const atmo = useThemeStore((s) => s.atmo);
  const setAtmo = useThemeStore((s) => s.setAtmo);
  const radius = useThemeStore((s) => s.radius);
  const setRadius = useThemeStore((s) => s.setRadius);
  const atmoN = ATMO.find((x) => x.v === atmo)?.n ?? 66;

  return (
    <div className="ftune">
      <div className="ftune-head">
        <span className="ftune-title">微调当前主题</span>
        <span className="ftune-adj">圆角 · 氛围</span>
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
      </div>
    </div>
  );
}
