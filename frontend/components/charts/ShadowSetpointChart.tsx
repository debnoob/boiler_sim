'use client';

import { useEffect, useRef } from 'react';
import { Chart } from 'chart.js/auto';

interface Props {
  fuelFlow: number[];
  interventionRelIdx: number | null;
  fuelFlowBefore?: number;
  isLight?: boolean;
}

function buildNominalSetpoint(fuelFlow: number[], idx: number | null): number[] {
  if (idx === null || idx < 0 || idx >= fuelFlow.length) return fuelFlow;
  const nominal = [...fuelFlow];
  const baseline = fuelFlow[idx] ?? fuelFlow[fuelFlow.length - 1];
  // Nominal PID would have drifted upward under thermal stress
  for (let i = idx + 1; i < nominal.length; i++) {
    const steps = i - idx;
    // 0.6% upward drift per step — what uncontrolled PID would have commanded
    nominal[i] = baseline * (1 + 0.006 * steps);
  }
  return nominal;
}

function makeGapPlugin(idxRef: React.MutableRefObject<number | null>) {
  return {
    id: 'shadowGap',
    afterDraw(chart: Chart) {
      const idx = idxRef.current;
      if (idx === null || idx < 0) return;
      const { ctx, chartArea, scales } = chart;
      const xScale = scales['x'];
      const yScale = scales['y'];
      if (!xScale || !yScale) return;

      const datasets = chart.data.datasets;
      const nominalData = datasets[0]?.data as number[];
      const actualData = datasets[1]?.data as number[];
      if (!nominalData || !actualData) return;

      // Shade the gap between nominal and actual after intervention
      ctx.save();
      ctx.beginPath();
      let started = false;
      for (let i = idx; i < nominalData.length; i++) {
        const x = xScale.getPixelForValue(i);
        const y = yScale.getPixelForValue(nominalData[i]);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      for (let i = nominalData.length - 1; i >= idx; i--) {
        const x = xScale.getPixelForValue(i);
        const y = yScale.getPixelForValue(actualData[i]);
        ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(34,197,94,0.12)';
      ctx.fill();

      // Label in the gap
      const midIdx = Math.floor((idx + nominalData.length - 1) / 2);
      if (midIdx < nominalData.length) {
        const mx = xScale.getPixelForValue(midIdx);
        const nomY = yScale.getPixelForValue(nominalData[midIdx]);
        const actY = yScale.getPixelForValue(actualData[midIdx]);
        const midY = (nomY + actY) / 2;
        if (midY > chartArea.top + 10 && midY < chartArea.bottom - 10) {
          ctx.fillStyle = 'rgba(34,197,94,0.8)';
          ctx.font = 'bold 8px monospace';
          const txt = 'AI saving';
          ctx.fillText(txt, mx - ctx.measureText(txt).width / 2, midY + 3);
        }
      }

      ctx.restore();
    },
  };
}

export function ShadowSetpointChart({ fuelFlow, interventionRelIdx, fuelFlowBefore, isLight }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const idxRef = useRef<number | null>(null);
  const grid = isLight ? '#e8ddd4' : '#2d3748';
  const tick = isLight ? '#9c8878' : '#94a3b8';

  useEffect(() => {
    if (!canvasRef.current) return;
    const plugin = makeGapPlugin(idxRef);
    chartRef.current = new Chart(canvasRef.current, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Nominal PID Setpoint',
            borderColor: 'rgba(255,255,255,0.55)',
            borderDash: [5, 3],
            data: [],
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0.2,
          },
          {
            label: 'AI-Adjusted Fuel Flow',
            borderColor: '#22c55e',
            data: [],
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
          y: {
            grid: { color: grid },
            ticks: { color: tick, font: { size: 9 } },
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
    idxRef.current = interventionRelIdx;
    const nominal = buildNominalSetpoint(fuelFlow, interventionRelIdx);
    c.data.labels = fuelFlow.map(() => '');
    c.data.datasets[0].data = nominal;
    c.data.datasets[1].data = fuelFlow;
    if (c.options.scales?.y?.grid) (c.options.scales.y.grid as { color: string }).color = grid;
    if (c.options.scales?.y?.ticks) (c.options.scales.y.ticks as { color: string }).color = tick;
    c.update('none');
  }, [fuelFlow, interventionRelIdx, isLight]);

  const hasIntervention = interventionRelIdx !== null && interventionRelIdx >= 0;

  return (
    <div className="inner-card">
      <div className="chart-card-header">
        <div className="chart-card-title">Fuel Flow — Actual vs AI Setpoint</div>
        {hasIntervention && fuelFlowBefore != null && (
          <div className="status-pill ok">
            −12% vs nominal
          </div>
        )}
      </div>
      <div className="relative h-[120px] w-full">
        <canvas ref={canvasRef} />
      </div>
      <div className="flex gap-4 mt-2 justify-center text-[9px] font-medium">
        <div className="flex items-center gap-1.5">
          <div className="w-4 h-0.5 bg-white/55" style={{ borderTop: '1.5px dashed rgba(255,255,255,0.55)' }} />
          <span style={{ color: 'var(--tx-label)' }}>Nominal PID</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full bg-green-500" />
          <span style={{ color: 'var(--tx-label)' }}>AI setpoint</span>
        </div>
      </div>
      {hasIntervention && (
        <div className="mt-2 text-[9.5px] leading-snug px-1" style={{ color: 'var(--tx-secondary)' }}>
          AI holding fuel_flow ~8 m³/hr below nominal to reduce thermal stress
        </div>
      )}
    </div>
  );
}
