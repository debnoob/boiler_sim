'use client';

import { useEffect, useRef } from 'react';
import { Chart } from 'chart.js/auto';

interface Props {
  labels: string[];
  efficiency: number[];
  tubeHealth: number[];
  heatRate: number[];
  isLight?: boolean;
  interventionRelIdx?: number | null;
}

function makeInterventionPlugin(idxRef: React.MutableRefObject<number | null>) {
  return {
    id: 'perfIntervention',
    afterDraw(chart: Chart) {
      const idx = idxRef.current;
      if (idx === null || idx < 0) return;
      const { ctx, chartArea, scales } = chart;
      const xScale = scales['x'];
      if (!xScale) return;
      const x = xScale.getPixelForValue(idx);
      if (x < chartArea.left || x > chartArea.right) return;

      ctx.save();
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();

      // Small label at top
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(245,158,11,0.2)';
      ctx.strokeStyle = 'rgba(245,158,11,0.6)';
      ctx.lineWidth = 1;
      const lw = 54, lh = 13;
      const lx = Math.min(x + 3, chartArea.right - lw - 2);
      const ly = chartArea.top + 4;
      ctx.fillRect(lx, ly, lw, lh);
      ctx.strokeRect(lx, ly, lw, lh);
      ctx.fillStyle = '#fbbf24';
      ctx.font = '8px monospace';
      ctx.fillText('AI action', lx + 4, ly + 9);

      ctx.restore();
    },
  };
}

export function PerformanceTrends({ labels, efficiency, tubeHealth, heatRate, isLight, interventionRelIdx = null }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const idxRef = useRef<number | null>(null);
  const grid = isLight ? '#e8ddd4' : '#2d3748';
  const tick = isLight ? '#9c8878' : '#94a3b8';

  useEffect(() => {
    if (!canvasRef.current) return;
    const plugin = makeInterventionPlugin(idxRef);
    chartRef.current = new Chart(canvasRef.current, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          { label: 'Efficiency %', borderColor: '#10b981', data: [], yAxisID: 'y', borderWidth: 2, pointRadius: 0, tension: 0.3 },
          { label: 'Tube Health %', borderColor: '#3b82f6', data: [], yAxisID: 'y', borderWidth: 2, borderDash: [4, 4], pointRadius: 0, tension: 0.3 },
          { label: 'Heat Rate', borderColor: '#f59e0b', data: [], yAxisID: 'y2', borderWidth: 2, pointRadius: 0, tension: 0.3 },
        ],
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } },
        scales: {
          x: { display: false },
          y: { type: 'linear', position: 'left', min: 40, max: 100, grid: { color: grid }, ticks: { color: tick, font: { size: 9 } } },
          y2: { type: 'linear', position: 'right', grid: { drawOnChartArea: false }, ticks: { color: tick, font: { size: 9 } } },
        },
      },
      plugins: [plugin],
    });
    return () => { chartRef.current?.destroy(); };
  }, []);

  useEffect(() => {
    if (!chartRef.current) return;
    const c = chartRef.current;
    idxRef.current = interventionRelIdx ?? null;

    // Efficiency segment coloring: before = orange-red (declining), after = green (recovering)
    const idx = interventionRelIdx;
    const effDs = c.data.datasets[0] as {
      borderColor: string | ((ctx: { p1DataIndex: number }) => string);
      segment?: { borderColor: (ctx: { p1DataIndex: number }) => string };
    };

    if (idx !== null && idx >= 0) {
      effDs.segment = {
        borderColor: (ctx) => ctx.p1DataIndex <= idx ? '#f97316' : '#10b981',
      };
    } else {
      effDs.segment = undefined;
      effDs.borderColor = '#10b981';
    }

    c.data.labels = labels;
    c.data.datasets[0].data = efficiency;
    c.data.datasets[1].data = tubeHealth;
    c.data.datasets[2].data = heatRate;
    if (c.options.scales?.y?.grid) (c.options.scales.y.grid as { color: string }).color = grid;
    if (c.options.scales?.y2?.ticks) (c.options.scales.y2.ticks as { color: string }).color = tick;
    if (c.options.scales?.y?.ticks) (c.options.scales.y.ticks as { color: string }).color = tick;
    c.update('none');
  }, [labels, efficiency, tubeHealth, heatRate, isLight, interventionRelIdx]);

  return (
    <div className="inner-card">
      <div className="chart-card-header">
        <div className="chart-card-title">System Performance Trends</div>
        <span className="status-pill info">Live 60s</span>
      </div>
      <div className="relative h-[120px] w-full">
        <canvas ref={canvasRef} />
      </div>
      <div className="flex gap-4 mt-2 justify-center text-[9px] font-medium">
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full bg-emerald-500" /><span style={{ color: 'var(--tx-label)' }}>Efficiency</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full bg-blue-500" /><span style={{ color: 'var(--tx-label)' }}>Tube Health</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full bg-amber-500" /><span style={{ color: 'var(--tx-label)' }}>Heat Rate</span>
        </div>
      </div>
    </div>
  );
}
