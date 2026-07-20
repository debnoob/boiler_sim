'use client';

import { useEffect, useRef } from 'react';
import { Chart } from 'chart.js/auto';

interface Props {
  labels: string[];
  steamTemp: number[];
  flueGasTemp: number[];
  isLight?: boolean;
  interventionRelIdx?: number | null;
  interventionLabel?: string | null;
}

function makeInterventionPlugin(idxRef: React.MutableRefObject<number | null>, labelRef: React.MutableRefObject<string | null>) {
  return {
    id: 'thermalIntervention',
    afterDraw(chart: Chart) {
      const idx = idxRef.current;
      if (idx === null || idx < 0) return;
      const { ctx, chartArea, scales } = chart;
      const xScale = scales['x'];
      if (!xScale) return;
      const x = xScale.getPixelForValue(idx);
      if (x < chartArea.left || x > chartArea.right) return;

      ctx.save();

      // Vertical dashed amber line
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();

      // Annotation bubble
      const label = labelRef.current ?? 'AI intervention';
      ctx.setLineDash([]);
      ctx.font = '8.5px monospace';
      const textWidth = ctx.measureText(label).width;
      const padX = 5, padY = 3;
      const boxW = textWidth + padX * 2;
      const boxH = 14;
      const boxX = Math.min(x + 5, chartArea.right - boxW - 2);
      const boxY = chartArea.top + 6;

      ctx.fillStyle = 'rgba(245,158,11,0.18)';
      ctx.strokeStyle = 'rgba(245,158,11,0.7)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(boxX, boxY, boxW, boxH);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#fbbf24';
      ctx.fillText(label, boxX + padX, boxY + boxH - padY);

      // "▎" indicator mark at top of line
      ctx.fillStyle = '#f59e0b';
      ctx.fillRect(x - 1, chartArea.top, 2, 6);

      ctx.restore();
    },
  };
}

export function ThermalCoupling({ labels, steamTemp, flueGasTemp, isLight, interventionRelIdx = null, interventionLabel = null }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const idxRef = useRef<number | null>(null);
  const labelRef = useRef<string | null>(null);
  const grid = isLight ? '#e8ddd4' : '#2d3748';
  const tick = isLight ? '#9c8878' : '#94a3b8';

  useEffect(() => {
    if (!canvasRef.current) return;
    const plugin = makeInterventionPlugin(idxRef, labelRef);
    chartRef.current = new Chart(canvasRef.current, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Steam Temp',
            borderColor: '#3b82f6',
            data: [],
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.3,
          },
          {
            label: 'Flue Gas Temp',
            borderColor: '#f43f5e',
            data: [],
            fill: '-1',
            backgroundColor: 'rgba(244,63,94,0.15)',
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.3,
          },
        ],
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { mode: 'index', intersect: false },
        },
        scales: {
          x: { display: false },
          y: { min: 150, max: 320, grid: { color: grid }, ticks: { color: tick, font: { size: 9 } } },
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
    labelRef.current = interventionLabel ?? null;

    // Segment coloring: before intervention = warm red, after = amber/yellow showing stabilization
    const idx = interventionRelIdx;
    const flueDs = c.data.datasets[1] as {
      borderColor: string | ((ctx: { p1DataIndex: number }) => string);
      backgroundColor: string | ((ctx: { p1DataIndex: number }) => string);
      segment?: {
        borderColor: (ctx: { p1DataIndex: number }) => string;
        backgroundColor: (ctx: { p1DataIndex: number }) => string;
      };
    };

    if (idx !== null && idx >= 0) {
      flueDs.segment = {
        borderColor: (ctx) => ctx.p1DataIndex <= idx ? '#ef4444' : '#fbbf24',
        backgroundColor: (ctx) => ctx.p1DataIndex <= idx ? 'rgba(239,68,68,0.18)' : 'rgba(251,191,36,0.1)',
      };
    } else {
      flueDs.segment = undefined;
      flueDs.borderColor = '#f43f5e';
      flueDs.backgroundColor = 'rgba(244,63,94,0.15)';
    }

    c.data.labels = labels;
    c.data.datasets[0].data = steamTemp;
    c.data.datasets[1].data = flueGasTemp;
    if (c.options.scales?.y?.grid) (c.options.scales.y.grid as { color: string }).color = grid;
    if (c.options.scales?.y?.ticks) (c.options.scales.y.ticks as { color: string }).color = tick;
    c.update('none');
  }, [labels, steamTemp, flueGasTemp, isLight, interventionRelIdx, interventionLabel]);

  const hasIntervention = interventionRelIdx !== null && interventionRelIdx >= 0;

  return (
    <div className="inner-card">
      <div className="chart-card-header">
        <div>
          <div className="chart-card-title">Thermal Coupling</div>
          <div className="text-[9px]" style={{ color: 'var(--tx-muted)' }}>steam vs flue-gas temp °C · gap widens on fouling</div>
        </div>
        {hasIntervention && (
          <div className="status-pill ai">AI intervened</div>
        )}
      </div>
      <div className="relative h-[120px] w-full">
        <canvas ref={canvasRef} />
      </div>
      <div className="flex gap-4 mt-2 justify-center text-[9px] font-medium">
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full bg-blue-500" /><span style={{ color: 'var(--tx-label)' }}>Steam Temp</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full" style={{ background: hasIntervention ? '#ef4444' : '#f43f5e' }} />
          <span style={{ color: 'var(--tx-label)' }}>Flue Gas</span>
          {hasIntervention && (
            <>
              <div className="w-2 h-2 rounded-full bg-amber-400" />
              <span style={{ color: 'var(--tx-label)' }}>(post-AI)</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
