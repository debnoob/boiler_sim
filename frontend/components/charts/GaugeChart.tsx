'use client';

import { useEffect, useRef } from 'react';
import { Chart } from 'chart.js/auto';

interface GaugeChartProps {
  value: number;
  maxValue: number;
  color: string;
  label: string;
  unit: string;
}

export function GaugeChart({ value, maxValue, color, label, unit }: GaugeChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);

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
    ds.data = [value, Math.max(0, maxValue - value)];
    ds.backgroundColor[0] = color;
    chartRef.current.update('none');
  }, [value, color]);

  return (
    <div className="inner-card relative flex flex-col items-center">
      <div className="text-[10px] w-full mb-1 text-center font-medium uppercase tracking-wider" style={{ color: 'var(--tx-label)' }}>
        {label}
      </div>
      <div className="relative w-full h-[80px] flex items-center justify-center">
        <canvas ref={canvasRef} />
        <div className="absolute inset-0 flex items-center justify-center pt-8 flex-col pointer-events-none">
          <span className="font-bold digit text-2xl val-highlight">{value > 0 ? value.toFixed(1) : '--'}</span>
          <span className="text-[10px] font-semibold" style={{ color: 'var(--tx-label)' }}>{unit}</span>
        </div>
      </div>
    </div>
  );
}
