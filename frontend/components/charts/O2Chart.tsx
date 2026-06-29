'use client';

interface O2ChartProps {
  value: number;
}

export function O2Chart({ value }: O2ChartProps) {
  const pct = Math.min(Math.max(value, 0), 10) * 10;
  const color = value >= 2 && value <= 4 ? '#10b981' : (value < 2 || (value > 4 && value <= 6)) ? '#f59e0b' : '#ef4444';

  return (
    <div className="inner-card flex flex-col justify-center">
      <div className="flex justify-between text-[10px] mb-3">
        <span className="font-medium uppercase tracking-wider" style={{ color: 'var(--tx-label)' }}>O₂ COMBUSTION</span>
        <span className="text-indigo-300 font-bold digit text-sm val-highlight">
          {value > 0 ? value.toFixed(2) + '%' : '--%'}
        </span>
      </div>
      <div
        className="relative h-4 rounded-sm w-full mt-2 overflow-hidden"
        style={{ background: 'var(--bg-elevated)', border: '1px solid var(--bd-inner)' }}
      >
        {/* Background zones (Target 2-4%) — 0-2% / 2-4% / 4-6% / >6% */}
        <div className="absolute h-full left-0 w-full flex">
          <div className="h-full bg-orange-500/10" style={{ width: '20%' }} />
          <div className="h-full bg-emerald-500/30 border-x border-emerald-500/50" style={{ width: '20%' }} />
          <div className="h-full bg-orange-500/10" style={{ width: '20%' }} />
          <div className="h-full bg-red-500/10" style={{ width: '40%' }} />
        </div>
        {/* Actual bar */}
        <div
          className="absolute h-1.5 top-[5px] left-0 rounded-sm transition-all duration-300"
          style={{ width: pct + '%', backgroundColor: color }}
        />
      </div>
      <div className="flex justify-between text-[9px] mt-1.5 font-medium" style={{ color: 'var(--tx-muted)' }}>
        <span>0%</span>
        <span className="text-emerald-500">Target 3.2%</span>
        <span>10%</span>
      </div>
    </div>
  );
}
