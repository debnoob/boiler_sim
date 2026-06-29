'use client';

import { useEffect, useState, useRef } from 'react';
import type { InterventionEvent } from '@/types/telemetry';
import { formatEta } from '@/lib/utils';

interface Props {
  forecastDeadline: number | null;
  interventionEvents: InterventionEvent[];
}

export function PredictiveRunwayGauge({ forecastDeadline, interventionEvents }: Props) {
  const [display, setDisplay] = useState<string>('—');
  const [gainedSecs, setGainedSecs] = useState<number>(0);
  const [isClimbing, setIsClimbing] = useState(false);
  const prevRemaining = useRef<number | null>(null);
  const climbTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Compute seconds gained: difference between current ETA and what it was at last intervention
  const lastEvent = interventionEvents[interventionEvents.length - 1];

  useEffect(() => {
    const tick = () => {
      if (forecastDeadline == null) {
        setDisplay('—');
        prevRemaining.current = null;
        return;
      }
      const now = Date.now() / 1000;
      const remaining = forecastDeadline - now;
      if (remaining <= 0) {
        setDisplay('IMMINENT');
        return;
      }

      const cur = remaining;
      const prev = prevRemaining.current;

      // Detect a jump upward (AI extended the runway)
      if (prev !== null && cur > prev + 5) {
        setGainedSecs(Math.round(cur - (lastEvent?.forecastDeadlineAtDetection
          ? lastEvent.forecastDeadlineAtDetection - now
          : prev)));
        setIsClimbing(true);
        if (climbTimer.current) clearTimeout(climbTimer.current);
        climbTimer.current = setTimeout(() => setIsClimbing(false), 4000);
      }

      prevRemaining.current = cur;
      setDisplay(formatEta(remaining));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      clearInterval(id);
      if (climbTimer.current) clearTimeout(climbTimer.current);
    };
  }, [forecastDeadline, lastEvent]);

  // Also compute gained time vs the intervention baseline
  const baselineEta = lastEvent?.forecastDeadlineAtDetection;
  const gainedDisplay = (() => {
    if (!baselineEta || forecastDeadline == null) return null;
    const now = Date.now() / 1000;
    const currentRemaining = forecastDeadline - now;
    const baselineRemaining = baselineEta - now;
    const delta = currentRemaining - baselineRemaining;
    if (delta <= 5) return null;
    return formatEta(delta);
  })();

  const isImminentWarning = display !== '—' && display !== 'IMMINENT' && forecastDeadline != null
    && (forecastDeadline - Date.now() / 1000) < 90;
  const hasRunway = display !== '—' && display !== 'IMMINENT';

  return (
    <div className="inner-card flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--tx-label)' }}>
          Predictive Runway
        </div>
        {lastEvent && (
          <div className="text-[9px] font-medium px-1.5 py-0.5 rounded" style={{ background: 'rgba(251,191,36,0.12)', border: '1px solid rgba(251,191,36,0.25)', color: '#fbbf24' }}>
            AI active
          </div>
        )}
      </div>

      {/* Main time display */}
      <div className="flex flex-col items-center py-1">
        <div className="text-[10px] font-medium mb-1" style={{ color: 'var(--tx-muted)' }}>
          Time to Critical
        </div>
        <div
          className={`digit font-black tracking-tight transition-all duration-500 ${isClimbing ? 'scale-110' : 'scale-100'}`}
          style={{
            fontSize: '2rem',
            lineHeight: 1,
            color: isClimbing ? '#4ade80'
              : display === 'IMMINENT' ? '#ef4444'
              : isImminentWarning ? '#f97316'
              : hasRunway ? '#fbbf24'
              : 'var(--tx-secondary)',
          }}
        >
          {display}
        </div>
        {isClimbing && (
          <div className="text-[10px] font-bold mt-1 animate-pulse" style={{ color: '#4ade80' }}>
            ↑ AI extending runway…
          </div>
        )}
      </div>

      {/* Gained time */}
      {gainedDisplay && (
        <div className="flex items-center justify-between rounded px-2 py-1.5" style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.25)' }}>
          <div className="text-[9px] font-medium" style={{ color: '#86efac' }}>AI bought you</div>
          <div className="digit font-bold text-sm" style={{ color: '#4ade80' }}>+{gainedDisplay}</div>
        </div>
      )}

      {/* Intervention history */}
      {lastEvent && (
        <div className="text-[9px] leading-snug" style={{ color: 'var(--tx-muted)' }}>
          Last action: {lastEvent.timestamp} · fuel_flow −{lastEvent.fuelFlowReduction}%
        </div>
      )}
    </div>
  );
}
