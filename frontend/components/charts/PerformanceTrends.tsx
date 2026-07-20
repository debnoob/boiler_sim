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

// Healthy-boiler baselines (match the engine's BASELINES). Efficiency and tube
// health read "higher is better"; heat rate reads "lower is better", so it is
// indexed inverted below. Result: every series is "% of baseline", 100 = baseline,
// up = healthier — one honest axis instead of the old dual y-scale, whose crossing
// points were an artifact of scaling rather than a real correlation.
const BASE = { efficiency: 87, tubeHealth: 97, heatRate: 10500 };

function makeOverlayPlugin(
  idxRef: React.MutableRefObject<number | null>,
) {
  return {
    id: 'perfOverlay',
    afterDraw(chart: Chart) {
      const { ctx, chartArea, scales } = chart;

      // Baseline reference at 100% of baseline.
      const yScale = scales['y'];
      if (yScale) {
        const y100 = yScale.getPixelForValue(100);
        if (y100 >= chartArea.top && y100 <= chartArea.bottom) {
          ctx.save();
          ctx.strokeStyle = 'rgba(148,163,184,0.35)';
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 3]);
          ctx.beginPath();
          ctx.moveTo(chartArea.left, y100);
          ctx.lineTo(chartArea.right, y100);
          ctx.stroke();
          ctx.restore();
        }
      }

      // Intervention marker.
      const idx = idxRef.current;
      if (idx === null || idx < 0) return;
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
  // Raw values kept for the tooltip so operators still see real numbers/units,
  // even though the plotted series are indexed to % of baseline.
  const rawRef = useRef<{ efficiency: number[]; tubeHealth: number[]; heatRate: number[] }>({
    efficiency: [], tubeHealth: [], heatRate: [],
  });
  const grid = isLight ? '#e8ddd4' : '#2d3748';
  const tick = isLight ? '#9c8878' : '#94a3b8';

  useEffect(() => {
    if (!canvasRef.current) return;
    const plugin = makeOverlayPlugin(idxRef);
    chartRef.current = new Chart(canvasRef.current, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          { label: 'Efficiency', borderColor: '#10b981', data: [], borderWidth: 2, pointRadius: 0, tension: 0.3 },
          { label: 'Tube Health', borderColor: '#3b82f6', data: [], borderWidth: 2, borderDash: [4, 4], pointRadius: 0, tension: 0.3 },
          { label: 'Heat Rate', borderColor: '#f59e0b', data: [], borderWidth: 2, pointRadius: 0, tension: 0.3 },
        ],
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            mode: 'index',
            intersect: false,
            callbacks: {
              label: (item) => {
                const i = item.dataIndex;
                const pct = item.formattedValue;
                const r = rawRef.current;
                if (item.datasetIndex === 0) return ` Efficiency ${r.efficiency[i]?.toFixed(1)}%  (${pct}% of baseline)`;
                if (item.datasetIndex === 1) return ` Tube Health ${r.tubeHealth[i]?.toFixed(1)}%  (${pct}% of baseline)`;
                return ` Heat Rate ${r.heatRate[i]?.toFixed(0)} kJ/kg  (${pct}% of baseline)`;
              },
            },
          },
        },
        scales: {
          x: { display: false },
          y: {
            min: 40,
            max: 115,
            grid: { color: grid },
            ticks: { color: tick, font: { size: 9 }, callback: (v) => `${v}%` },
          },
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
    rawRef.current = { efficiency, tubeHealth, heatRate };

    // Efficiency segment coloring: before = orange (declining), after = green (recovering)
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
    // Index each series to % of baseline. Heat rate is inverted (baseline/value)
    // so that, like the others, a higher line means a healthier boiler.
    c.data.datasets[0].data = efficiency.map((v) => (v / BASE.efficiency) * 100);
    c.data.datasets[1].data = tubeHealth.map((v) => (v / BASE.tubeHealth) * 100);
    c.data.datasets[2].data = heatRate.map((v) => (v > 0 ? (BASE.heatRate / v) * 100 : 100));
    if (c.options.scales?.y?.grid) (c.options.scales.y.grid as { color: string }).color = grid;
    if (c.options.scales?.y?.ticks) (c.options.scales.y.ticks as { color: string }).color = tick;
    c.update('none');
  }, [labels, efficiency, tubeHealth, heatRate, isLight, interventionRelIdx]);

  return (
    <div className="inner-card">
      <div className="chart-card-header">
        <div>
          <div className="chart-card-title">Performance vs Baseline</div>
          <div className="text-[9px]" style={{ color: 'var(--tx-muted)' }}>100% = baseline · higher is healthier · 60s</div>
        </div>
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
