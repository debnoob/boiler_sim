'use client';

import { useEffect, useRef } from 'react';
import { Chart } from 'chart.js/auto';

interface GaugeChartProps {
  value: number;
  maxValue: number;
  color: string;
  label: string;
  unit: string;
  setpoint?: number;
  reference?: string;
  statusLabel?: string;
  zones?: Array<{ from: number; to: number; color: string; label?: string }>;
}

export function GaugeChart({
  value,
  maxValue,
  color,
  label,
  unit,
  setpoint,
  reference,
  statusLabel,
  zones,
}: GaugeChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const clampedValue = Math.min(Math.max(value, 0), maxValue);

  useEffect(() => {
    if (!canvasRef.current) return;
    chartRef.current = new Chart(canvasRef.current, {
      type: 'doughnut',
      data: {
        datasets: [{
          data: [0, maxValue],
          backgroundColor: [color, '#334155'],
          borderWidth: 0,
          circumference: 180,
          rotation: 270,
        }],
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        cutout: '75%',
        plugins: { tooltip: { enabled: false }, legend: { display: false } },
      },
    });
    return () => { chartRef.current?.destroy(); };
  }, []);

  useEffect(() => {
    if (!chartRef.current) return;
    const ds = chartRef.current.data.datasets[0] as { data: number[]; backgroundColor: string[] };
    ds.data = [clampedValue, Math.max(0, maxValue - clampedValue)];
    ds.backgroundColor[0] = color;
    chartRef.current.update('none');
  }, [clampedValue, color, maxValue]);

  return (
    <div className="inner-card relative flex flex-col items-center gap-2">
      <div className="w-full flex items-center justify-between gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--tx-label)' }}>
          {label}
        </div>
        {statusLabel && (
          <div className="text-[9px] font-bold uppercase tracking-wider" style={{ color }}>
            {statusLabel}
          </div>
        )}
      </div>
      <div className="relative w-full h-[80px] flex items-center justify-center">
        <canvas ref={canvasRef} />
        <div className="absolute inset-0 flex items-center justify-center pt-8 flex-col pointer-events-none">
          <span className="font-bold digit text-2xl val-highlight">{value > 0 ? value.toFixed(1) : '--'}</span>
          <span className="text-[10px] font-semibold" style={{ color: 'var(--tx-label)' }}>{unit}</span>
        </div>
      </div>
      {zones && zones.length > 0 && (
        <div className="w-full">
          <div className="relative h-3 rounded-sm overflow-hidden" style={{ background: 'var(--bg-base)', border: '1px solid var(--bd-inner)' }}>
            {zones.map((z, i) => {
              const left = Math.max(0, Math.min(100, (z.from / maxValue) * 100));
              const width = Math.max(0, Math.min(100 - left, ((z.to - z.from) / maxValue) * 100));
              return (
                <div
                  key={`${z.from}-${z.to}-${i}`}
                  title={z.label}
                  style={{
                    position: 'absolute',
                    left: `${left}%`,
                    width: `${width}%`,
                    top: 0,
                    bottom: 0,
                    background: z.color,
                    opacity: 0.75,
                  }}
                />
              );
            })}
            {setpoint != null && (
              <div
                title={`Setpoint ${setpoint} ${unit}`}
                style={{
                  position: 'absolute',
                  left: `${Math.max(0, Math.min(100, (setpoint / maxValue) * 100))}%`,
                  top: -2,
                  bottom: -2,
                  width: 2,
                  background: '#f8fafc',
                  boxShadow: '0 0 0 1px rgba(0,0,0,0.35)',
                }}
              />
            )}
            <div
              title={`Current ${value.toFixed(1)} ${unit}`}
              style={{
                position: 'absolute',
                left: `${Math.max(0, Math.min(100, (clampedValue / maxValue) * 100))}%`,
                top: -1,
                bottom: -1,
                width: 3,
                background: color,
                boxShadow: '0 0 0 1px rgba(0,0,0,0.45), 0 0 8px rgba(255,255,255,0.45)',
              }}
            />
          </div>
          {reference && (
            <div className="mt-1 text-[9px] leading-tight" style={{ color: 'var(--tx-muted)' }}>
              {reference}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
