'use client';

import { useEffect, useRef } from 'react';
import { Chart } from 'chart.js/auto';
import type { ForecastMetric } from '@/types/telemetry';
import { vizPalette } from '@/lib/vizPalette';

interface Props {
  metric: ForecastMetric | undefined;
  label: string;
  color: string;        // e.g. '#3b82f6'
  breachLine?: number;  // optional horizontal threshold
  isLight?: boolean;
  backend?: string;
  size?: 'compact' | 'hero';
  subtitle?: string;
}

function makeChartAreaPlugin(isLightRef: React.MutableRefObject<boolean | undefined>) {
  return {
    id: 'forecastChartArea',
    beforeDatasetsDraw(chart: Chart) {
      const { ctx, chartArea } = chart;
      if (!chartArea) return;
      const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
      if (isLightRef.current) {
        gradient.addColorStop(0, 'rgba(8,145,178,0.055)');
        gradient.addColorStop(1, 'rgba(8,145,178,0.00)');
      } else {
        gradient.addColorStop(0, 'rgba(56,189,248,0.075)');
        gradient.addColorStop(1, 'rgba(56,189,248,0.00)');
      }
      ctx.save();
      ctx.fillStyle = gradient;
      ctx.fillRect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, chartArea.bottom - chartArea.top);
      ctx.restore();
    },
  };
}

function makeForecastDividerPlugin(
  boundaryRef: React.MutableRefObject<{ hist: number; total: number }>,
  showLabelsRef: React.MutableRefObject<boolean>,
) {
  return {
    id: 'forecastDivider',
    afterDatasetsDraw(chart: Chart) {
      const { ctx, chartArea, scales } = chart;
      const { hist, total } = boundaryRef.current;
      if (!chartArea || !scales.x || hist <= 0 || hist >= total) return;
      const x = scales.x.getPixelForValue(hist - 0.5);
      if (!Number.isFinite(x)) return;
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(148,163,184,0.4)';
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      if (showLabelsRef.current) {
        ctx.font = '700 9px Inter, system-ui, sans-serif';
        ctx.textBaseline = 'top';
        ctx.fillStyle = 'rgba(148,163,184,0.7)';
        ctx.textAlign = 'right';
        ctx.fillText('HISTORY', x - 6, chartArea.top + 3);
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(56,189,248,0.85)';
        ctx.fillText('FORECAST', x + 6, chartArea.top + 3);
      }
      ctx.restore();
    },
  };
}

export function ForecastChart({ metric, label, color, breachLine, isLight, backend, size = 'compact', subtitle }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef  = useRef<Chart | null>(null);
  const lightRef = useRef(isLight);
  const boundaryRef = useRef<{ hist: number; total: number }>({ hist: 0, total: 0 });
  const showLabelsRef = useRef(size === 'hero');
  const palette = vizPalette(Boolean(isLight));
  const grid = palette.grid;
  const tick = palette.tick;

  // Build the colour variants once
  const colorAlpha = (hex: string, a: number) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${a})`;
  };

  // ── Initialise chart ──────────────────────────────────────
  useEffect(() => {
    if (!canvasRef.current) return;

    const datasets: any[] = [
      // 0 — history (solid)
      {
        label: `${label} (actual)`,
        data: [],
        borderColor: color,
        backgroundColor: 'transparent',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.3,
        order: 1,
      },
      // 1 — p90 upper band (transparent border, fill to index 3)
      {
        label: `${label} p90`,
        data: [],
        borderColor: 'transparent',
        backgroundColor: colorAlpha(color, 0.18),
        borderWidth: 0,
        pointRadius: 0,
        tension: 0.3,
        fill: '+2',   // fills between dataset[1] and dataset[3]
        order: 3,
      },
      // 2 — p50 median forecast (dashed)
      {
        label: `${label} forecast (median)`,
        data: [],
        borderColor: color,
        backgroundColor: 'transparent',
        borderWidth: 2,
        borderDash: [5, 4],
        pointRadius: 0,
        tension: 0.3,
        order: 2,
      },
      // 3 — p10 lower band (transparent)
      {
        label: `${label} p10`,
        data: [],
        borderColor: 'transparent',
        backgroundColor: 'transparent',
        borderWidth: 0,
        pointRadius: 0,
        tension: 0.3,
        order: 3,
      },
    ];

    if (breachLine !== undefined) {
      datasets.push({
        label: `${breachLine} threshold`,
        data: [],
        borderColor: 'rgba(239,68,68,0.72)',
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        borderDash: [4, 4],
        pointRadius: 0,
        tension: 0,
        order: 4,
      });
    }

    const chartAreaPlugin = makeChartAreaPlugin(lightRef);
    const dividerPlugin = makeForecastDividerPlugin(boundaryRef, showLabelsRef);
    chartRef.current = new Chart(canvasRef.current, {
      type: 'line',
      data: { labels: [], datasets },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                if (ctx.dataset.label?.includes('p90') || ctx.dataset.label?.includes('p10')) return '';
                return `${ctx.dataset.label}: ${typeof ctx.raw === 'number' ? ctx.raw.toFixed(2) : ctx.raw}`;
              },
            },
          },
        },
        scales: {
          x: { display: false },
          y: {
            grid: { color: grid },
            ticks: { color: tick, font: { size: 9 } },
          },
        },
      },
      plugins: [chartAreaPlugin, dividerPlugin],
    });

    return () => { chartRef.current?.destroy(); };
  }, []);

  // ── Update data ───────────────────────────────────────────
  useEffect(() => {
    const c = chartRef.current;
    if (!c) return;
    lightRef.current = isLight;

    if (!metric) {
      c.data.labels = [];
      c.data.datasets.forEach(ds => { ds.data = []; });
      boundaryRef.current = { hist: 0, total: 0 };
      c.update('none');
      return;
    }

    const histLen  = metric.history.length;
    const foreLen  = metric.p50.length;
    boundaryRef.current = { hist: histLen, total: histLen + foreLen };
    // Labels: empty strings for history, "+1s", "+2s"... for forecast
    const labels = [
      ...Array(histLen).fill(''),
      ...metric.p50.map((_, i) => `+${i + 1}s`),
    ];

    // history dataset: real values then null padding for forecast region
    const histData  = [...metric.history, ...Array(foreLen).fill(null)];
    // forecast datasets: null padding for history region, then values
    const nullHist  = Array(histLen).fill(null);
    const p90Data   = [...nullHist, ...metric.p90];
    const p50Data   = [...nullHist, ...metric.p50];
    const p10Data   = [...nullHist, ...metric.p10];

    c.data.labels        = labels;
    c.data.datasets[0].data = histData;
    c.data.datasets[1].data = p90Data;
    c.data.datasets[2].data = p50Data;
    c.data.datasets[3].data = p10Data;
    if (breachLine !== undefined && c.data.datasets[4]) {
      c.data.datasets[4].data = Array(histLen + foreLen).fill(breachLine);
    }

    // Theme update
    if (c.options.scales?.y?.grid) (c.options.scales.y.grid as any).color = grid;
    if (c.options.scales?.y?.ticks) (c.options.scales.y.ticks as any).color = tick;

    c.update('none');
  }, [metric, isLight]);

  const hasData = metric && metric.p50.length > 0;

  return (
    <div className="inner-card">
      <div className="chart-card-header">
        <div>
          <div className="chart-card-title">{label} · Moirai Forecast</div>
          {subtitle && (
            <div className="mt-1 text-[10.5px] font-medium normal-case tracking-normal" style={{ color: 'var(--tx-secondary)' }}>
              {subtitle}
            </div>
          )}
        </div>
        {backend && (
          <span
            className={`status-pill ${backend === 'simulation' ? 'warn' : 'ok'}`}
          >
            {backend === 'uni2ts' ? 'Moirai AI' : backend === 'simulation' ? 'Sim' : 'HF'}
          </span>
        )}
      </div>

      <div className={`relative w-full ${size === 'hero' ? 'h-[300px]' : 'h-[130px]'}`}>
        {!hasData && (
          <div className="absolute inset-0 loading-state">
            <span className="loading-dot" />
            <span>Waiting for forecast data</span>
          </div>
        )}
        <canvas ref={canvasRef} />
      </div>

      {/* Legend */}
      <div className="flex gap-3 mt-2 justify-center text-[9px] font-medium flex-wrap">
        <div className="flex items-center gap-1">
          <div className="w-5 h-[2px]" style={{ background: color }} />
          <span style={{ color: 'var(--tx-label)' }}>Actual</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-5 h-[2px]" style={{ background: color, opacity: 0.8, borderTop: '2px dashed ' + color }} />
          <span style={{ color: 'var(--tx-label)' }}>Median (p50)</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-5 h-3 rounded-sm" style={{ background: colorAlpha(color, 0.25) }} />
          <span style={{ color: 'var(--tx-label)' }}>p10–p90 band</span>
        </div>
        {breachLine !== undefined && (
          <div className="flex items-center gap-1">
            <div className="w-5 h-[2px] bg-red-500" style={{ borderTop: '2px dashed #ef4444' }} />
            <span className="text-red-400">Threshold</span>
          </div>
        )}
      </div>
    </div>
  );
}

// Helper exposed for parent components
export function colorAlpha(hex: string, a: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}
