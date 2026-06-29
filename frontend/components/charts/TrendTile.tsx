'use client';

import { useId } from 'react';

interface TrendTileProps {
  label: string;
  value: string;
  unit?: string;
  data: number[];
  color?: string;
}

const VB_W = 320;
const VB_H = 96;

/**
 * Compact labeled area-trend tile for the Overview trend strip.
 * Pure SVG (responsive via non-distorting stroke) so it stays crisp at any width.
 */
export function TrendTile({ label, value, unit, data, color = '#10b981' }: TrendTileProps) {
  const gid = useId();
  const pts = data.filter((v) => Number.isFinite(v));
  const pad = 6;

  let body: React.ReactNode;
  let minLabel = '--';
  let maxLabel = '--';

  if (pts.length < 2) {
    body = (
      <line
        x1={pad} y1={VB_H / 2} x2={VB_W - pad} y2={VB_H / 2}
        stroke={color} strokeWidth={1.5} strokeOpacity={0.3} strokeDasharray="3 4"
        vectorEffect="non-scaling-stroke"
      />
    );
  } else {
    const min = Math.min(...pts);
    const max = Math.max(...pts);
    const range = max - min || 1;
    const n = pts.length;
    minLabel = min.toFixed(1);
    maxLabel = max.toFixed(1);

    const coords = pts.map((v, i) => {
      const x = (i / (n - 1)) * (VB_W - pad * 2) + pad;
      const y = VB_H - pad - ((v - min) / range) * (VB_H - pad * 2);
      return [x, y] as const;
    });
    const line = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const area = `${line} L${coords[n - 1][0].toFixed(1)},${VB_H - pad} L${coords[0][0].toFixed(1)},${VB_H - pad} Z`;
    const [lx, ly] = coords[n - 1];

    body = (
      <>
        <path d={area} fill={`url(#${gid})`} />
        <path
          d={line} fill="none" stroke={color} strokeWidth={1.75}
          strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke"
        />
        <circle cx={lx} cy={ly} r={2.5} fill={color} />
      </>
    );
  }

  return (
    <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--tx-muted)' }}>
          {label}
        </span>
        <span style={{ fontSize: 18, fontWeight: 800, color: 'var(--tx-primary)', fontVariantNumeric: 'tabular-nums' }}>
          {value}
          {unit && value !== '--' && <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--tx-muted)', marginLeft: 3 }}>{unit}</span>}
        </span>
      </div>

      {/* Chart */}
      <svg width="100%" height={72} viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="none" aria-hidden="true" style={{ display: 'block' }}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.26} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        {body}
      </svg>

      {/* Footer min/max */}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5, color: 'var(--tx-muted)', fontVariantNumeric: 'tabular-nums' }}>
        <span>min {minLabel}</span>
        <span>max {maxLabel}</span>
      </div>
    </div>
  );
}
