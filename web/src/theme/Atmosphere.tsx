// 职责：背景氛围层（#atmo）——按主题 atmo spec 渲染光晕 / 星空 / 光斑，档位控制强度（off/soft/on/strong）。
// 渲染逻辑与 taskboard-v9 renderAtmo 一致：glow/blobs 走 CSS 径向渐变，stars 走内联 SVG 散点。
import { useMemo } from 'react';
import { useThemeStore, type AtmoLevel } from './ThemeProvider';
import { useThemeCtx } from './ThemeProvider';
import type { AtmoSpec } from './themes';

const LEVEL_OPACITY: Record<AtmoLevel, number> = { off: 0, soft: 0.5, on: 0.75, strong: 1 };

/** 确定性伪随机（与原型同种子算法，保证每套主题星空稳定） */
function seededRand(seed0: number) {
  let seed = seed0;
  return () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
}

function renderAtmo(a: AtmoSpec, o: number): { style: React.CSSProperties; inner: string } {
  if (a.type === 'glow') {
    return {
      style: {
        background: `radial-gradient(640px 420px at ${a.pos || '50% 0%'}, ${a.color}, transparent 72%)`,
        opacity: o,
      },
      inner: '',
    };
  }
  if (a.type === 'blobs') {
    return {
      style: {
        background: a.blobs.map((b) => `radial-gradient(${b.r} at ${b.x} ${b.y}, ${b.c}, transparent 70%)`).join(','),
        opacity: o,
      },
      inner: '',
    };
  }
  // stars
  const rand = seededRand(7);
  const count = a.count || 60;
  let pts = '';
  for (let i = 0; i < count; i++) {
    const x = (rand() * 100).toFixed(1);
    const y = (rand() * 100).toFixed(1);
    const r = (rand() * 1.0 + 0.3).toFixed(1);
    pts += `<circle cx="${x}%" cy="${y}%" r="${r}" fill="${a.color || 'rgba(255,255,255,.4)'}"/>`;
  }
  return {
    style: { opacity: 1 },
    inner: `<svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none" style="opacity:${0.8 * o}">${pts}</svg>`,
  };
}

export function Atmosphere() {
  const { theme } = useThemeCtx();
  const atmo = useThemeStore((s) => s.atmo);
  const { style, inner } = useMemo(() => {
    if (atmo === 'off' || !theme.atmo) return { style: { display: 'none' } as React.CSSProperties, inner: '' };
    return renderAtmo(theme.atmo, LEVEL_OPACITY[atmo]);
  }, [theme, atmo]);

  return (
    <div
      id="atmo"
      aria-hidden="true"
      style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none', ...style }}
      dangerouslySetInnerHTML={inner ? { __html: inner } : undefined}
    />
  );
}
