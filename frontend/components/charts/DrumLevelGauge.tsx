'use client';

interface DrumLevelGaugeProps {
  value: number;
}

const MAX_LEVEL = 800;
const SETPOINT = 400;

function pct(v: number) {
  return Math.max(0, Math.min(100, (v / MAX_LEVEL) * 100));
}

function levelStatus(value: number) {
  if (value < 200 || value > 720) return { label: 'CRITICAL', color: '#ef4444' };
  if (value < 280 || value > 600) return { label: 'WARNING', color: '#f59e0b' };
  return { label: 'NORMAL', color: '#10b981' };
}

export function DrumLevelGauge({ value }: DrumLevelGaugeProps) {
  const status = levelStatus(value);
  const levelPct = pct(value);
  const setpointPct = pct(SETPOINT);

  return (
    <div className="inner-card flex flex-col gap-2 min-h-[158px]">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--tx-label)' }}>
          DRUM LEVEL
        </div>
        <div className="text-[9px] font-bold uppercase tracking-wider" style={{ color: status.color }}>
          {status.label}
        </div>
      </div>

      <div className="flex items-stretch gap-3 flex-1 min-h-0">
        <div
          className="relative w-14 rounded-md overflow-hidden"
          style={{ background: 'var(--bg-base)', border: '1px solid var(--bd-inner)' }}
        >
          <Band from={0} to={200} color="rgba(239,68,68,0.55)" />
          <Band from={200} to={280} color="rgba(245,158,11,0.55)" />
          <Band from={280} to={600} color="rgba(16,185,129,0.42)" />
          <Band from={600} to={720} color="rgba(245,158,11,0.55)" />
          <Band from={720} to={800} color="rgba(239,68,68,0.55)" />

          <div
            title={`Current ${value.toFixed(1)} mm`}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              height: `${levelPct}%`,
              background: 'linear-gradient(180deg, rgba(125,211,252,0.85), rgba(14,165,233,0.72))',
              borderTop: `2px solid ${status.color}`,
              boxShadow: '0 -6px 16px rgba(14,165,233,0.18)',
            }}
          />

          <Marker pct={setpointPct} color="#f8fafc" label="SP" />
          <Marker pct={levelPct} color={status.color} label="" strong />
        </div>

        <div className="flex-1 min-w-0 flex flex-col justify-center gap-2">
          <div>
            <div className="font-bold digit text-3xl val-highlight" style={{ color: status.color }}>
              {value > 0 ? value.toFixed(1) : '--'}
            </div>
            <div className="text-[10px] font-semibold" style={{ color: 'var(--tx-label)' }}>mm</div>
          </div>
          <div className="grid grid-cols-2 gap-1 text-[9px]" style={{ color: 'var(--tx-muted)' }}>
            <span>SP 400</span>
            <span>Range 0-800</span>
            <span>Low 280</span>
            <span>High 600</span>
            <span>Crit &lt;200</span>
            <span>Crit &gt;720</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Band({ from, to, color }: { from: number; to: number; color: string }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: `${pct(from)}%`,
        height: `${pct(to) - pct(from)}%`,
        background: color,
      }}
    />
  );
}

function Marker({ pct: p, color, label, strong }: { pct: number; color: string; label: string; strong?: boolean }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: `${p}%`,
        height: strong ? 3 : 2,
        background: color,
        boxShadow: '0 0 0 1px rgba(0,0,0,0.35)',
      }}
    >
      {label && (
        <span
          style={{
            position: 'absolute',
            left: '100%',
            top: -7,
            marginLeft: 5,
            fontSize: 9,
            fontWeight: 800,
            color,
          }}
        >
          {label}
        </span>
      )}
    </div>
  );
}
