// ────────────────────────────────────────────────────────────────────
// Shared data-visualization palette — single source of truth for both
// the Overview and Operations boards so the app reads as one system.
//
// Every value below was validated with the dataviz palette checker
// (lightness band, chroma floor, colorblind separation, contrast) for
// BOTH themes, against the app's actual card surfaces:
//   light card surface #edf4f8 · dark card surface #17202b
//
// Factor hues are categorical identity (always paired with a text label).
// Status hues are reserved state colors and are never reused as a series.
// ────────────────────────────────────────────────────────────────────

/** Hex → rgba() with alpha. */
export const hexA = (hex: string, a: number): string => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

export interface VizPalette {
  /** Categorical identity hues for the three OEE factors. */
  factor: { avail: string; thermal: string; quality: string };
  /** Reserved state colors (good / warning / critical / info). */
  status: { good: string; warn: string; crit: string; info: string };
  /** Chart chrome. */
  track: string;
  tick: string;
  grid: string;
}

export function vizPalette(isLight: boolean): VizPalette {
  return isLight
    ? {
        factor: { avail: '#2a78d6', thermal: '#0e93a8', quality: '#4a3aa7' },
        status: { good: '#16a34a', warn: '#d97706', crit: '#dc2626', info: '#2a78d6' },
        track: '#e2e8f0',
        tick: '#64748b',
        grid: 'rgba(15,23,42,0.06)',
      }
    : {
        factor: { avail: '#3987e5', thermal: '#1298ad', quality: '#9085e9' },
        status: { good: '#22c55e', warn: '#f59e0b', crit: '#ef4444', info: '#38bdf8' },
        track: '#1f2a36',
        tick: '#8b96a3',
        grid: 'rgba(255,255,255,0.045)',
      };
}

/** OEE band color for a 0–100 score (status semantics). */
export function oeeColor(o: number, isLight: boolean): string {
  const s = vizPalette(isLight).status;
  if (o >= 85) return s.good;
  if (o >= 75) return isLight ? '#ca8a04' : '#eab308';
  if (o >= 60) return s.warn;
  return s.crit;
}

/** Operating-state color for status timelines. */
export function stateColor(st: string, isLight: boolean): string {
  const p = vizPalette(isLight);
  switch (st) {
    case 'production': return p.status.good;
    case 'slow': return p.status.warn;
    case 'downtime': return p.status.crit;
    case 'critical': return isLight ? '#ea580c' : '#f97316';
    case 'setup': return p.factor.avail;
    default: return '#64748b';
  }
}

/** Generic tone keyword → status color. Accepts good/warn/bad/crit/neutral. */
export function toneColor(tone: string, isLight: boolean): string {
  const s = vizPalette(isLight).status;
  switch (tone) {
    case 'good': return s.good;
    case 'warn': return s.warn;
    case 'bad':
    case 'crit': return s.crit;
    default: return 'var(--tx-primary)';
  }
}
