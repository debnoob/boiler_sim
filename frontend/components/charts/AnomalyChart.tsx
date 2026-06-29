'use client';

import { useEffect, useRef } from 'react';
import { Chart } from 'chart.js/auto';

interface Props {
  labels: string[];
  data: number[];
  score: number;
  isLight?: boolean;
}

export function AnomalyChart({ labels, data, score, isLight }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const grid = isLight ? '#e8ddd4' : '#2d3748';
  const tick = isLight ? '#9c8878' : '#94a3b8';

  const getColors = (s: number) => ({
    border: s > 70 ? '#ef4444' : s > 30 ? '#f59e0b' : '#10b981',
    bg: s > 70 ? 'rgba(239,68,68,0.2)' : s > 30 ? 'rgba(245,158,11,0.2)' : 'rgba(16,185,129,0.2)',
    scoreClass: s > 70
      ? 'text-red-500 font-bold digit text-[11px] px-2 py-0.5 bg-red-500/10 rounded border border-red-500/20 animate-pulse'
      : s > 30
      ? 'text-amber-400 font-bold digit text-[11px] px-2 py-0.5 bg-amber-500/10 rounded border border-amber-500/20'
      : 'text-emerald-500 font-bold digit text-[11px] px-2 py-0.5 bg-emerald-500/10 rounded border border-emerald-500/20',
  });

  useEffect(() => {
    if (!canvasRef.current) return;
    chartRef.current = new Chart(canvasRef.current, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label: 'Anomaly Score',
          borderColor: '#10b981',
          backgroundColor: 'rgba(16,185,129,0.2)',
          fill: true,
          data: [],
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.4,
        }],
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } },
        scales: {
          x: { display: false },
          y: { min: 0, max: 100, grid: { color: grid }, ticks: { color: tick, font: { size: 9 } } },
        },
      },
    });
    return () => { chartRef.current?.destroy(); };
  }, []);

  useEffect(() => {
    if (!chartRef.current) return;
    const c = chartRef.current;
    const { border, bg } = getColors(score);
    c.data.labels = labels;
    c.data.datasets[0].data = data;
    (c.data.datasets[0] as { borderColor: string; backgroundColor: string }).borderColor = border;
    (c.data.datasets[0] as { borderColor: string; backgroundColor: string }).backgroundColor = bg;
    if (c.options.scales?.y?.grid) (c.options.scales.y.grid as { color: string }).color = grid;
    if (c.options.scales?.y?.ticks) (c.options.scales.y.ticks as { color: string }).color = tick;
    c.update('none');
  }, [labels, data, score, isLight]);

  const { scoreClass } = getColors(score);

  return (
    <div className="inner-card">
      <div className="flex justify-between items-center mb-2">
        <div className="text-[10px] font-semibold tracking-wider uppercase" style={{ color: 'var(--tx-label)' }}>
          ML Anomaly Score History
        </div>
        <span className={scoreClass}>{score.toFixed(1)}%</span>
      </div>
      <div className="relative h-[120px] w-full">
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}
