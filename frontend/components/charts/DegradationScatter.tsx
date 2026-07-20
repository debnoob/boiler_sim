'use client';

import { useEffect, useRef } from 'react';
import { Chart } from 'chart.js/auto';

interface ScatterPoint { x: number; y: number; }

interface Props {
  data: ScatterPoint[];
  isLight?: boolean;
}

export function DegradationScatter({ data, isLight }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const grid = isLight ? '#e8ddd4' : '#2d3748';
  const tick = isLight ? '#9c8878' : '#94a3b8';

  useEffect(() => {
    if (!canvasRef.current) return;
    chartRef.current = new Chart(canvasRef.current, {
      type: 'scatter',
      data: {
        datasets: [{ label: 'Live Cluster', data: [], backgroundColor: '#3b82f6', pointRadius: 3 }],
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { display: true, min: 120, max: 180, grid: { color: grid }, ticks: { color: tick, font: { size: 9 } } },
          y: { display: true, min: 2000, max: 2600, grid: { color: grid }, ticks: { color: tick, font: { size: 9 } } },
        },
      },
    });
    return () => { chartRef.current?.destroy(); };
  }, []);

  useEffect(() => {
    if (!chartRef.current) return;
    const c = chartRef.current;
    c.data.datasets[0].data = data;
    if (c.options.scales?.x?.grid) (c.options.scales.x.grid as { color: string }).color = grid;
    if (c.options.scales?.y?.grid) (c.options.scales.y.grid as { color: string }).color = grid;
    if (c.options.scales?.x?.ticks) (c.options.scales.x.ticks as { color: string }).color = tick;
    if (c.options.scales?.y?.ticks) (c.options.scales.y.ticks as { color: string }).color = tick;
    c.update('none');
  }, [data, isLight]);

  return (
    <div className="inner-card">
      <div className="chart-card-header">
        <div>
          <div className="chart-card-title">Firing vs Steam Output</div>
          <div className="text-[9px]" style={{ color: 'var(--tx-muted)' }}>fuel m³/hr vs steam kg/hr · cluster drifts on degradation</div>
        </div>
      </div>
      <div className="relative h-[120px] w-full">
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}
