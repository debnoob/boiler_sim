'use client';

import { useId } from 'react';

interface SparklineProps {
  data: number[];
  color?: string;
  width?: number;
  height?: number;
  fill?: boolean;
  strokeWidth?: number;
}

/**
 * Lightweight inline trend sparkline — pure SVG, no chart library.
 * Auto-scales to the data's own min/max so small live movements stay visible.
 */
export function Sparkline({
  data,
  color = '#22c55e',
  width = 110,
  height = 32,
  fill = true,
  strokeWidth = 1.5,
}: SparklineProps) {
  const gid = useId();
  const pts = data.filter((v) => Number.isFinite(v));
  const pad = strokeWidth + 1.5;

  // Not enough data yet — render a flat baseline so the card never looks broken.
  if (pts.length < 2) {
    return (
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
        <line
          x1={pad} y1={height / 2} x2={width - pad} y2={height / 2}
          stroke={color} strokeWidth={strokeWidth} strokeOpacity={0.3} strokeDasharray="2 3"
        />
      </svg>
    );
  }

  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const range = max - min || 1;
  const n = pts.length;

  const coords = pts.map((v, i) => {
    const x = (i / (n - 1)) * (width - pad * 2) + pad;
    const y = height - pad - ((v - min) / range) * (height - pad * 2);
    return [x, y] as const;
  });

  const line = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${coords[n - 1][0].toFixed(1)},${height - pad} L${coords[0][0].toFixed(1)},${height - pad} Z`;
  const [lx, ly] = coords[n - 1];

  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.3} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      {fill && <path d={area} fill={`url(#${gid})`} />}
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={lx} cy={ly} r={2} fill={color} />
    </svg>
  );
}
