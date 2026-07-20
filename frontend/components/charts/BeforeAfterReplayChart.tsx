'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Chart } from 'chart.js/auto';

interface Props {
  efficiency: number[];
  flueGasTemp: number[];
  interventionRelIdx: number | null;
  interventionTimestamp?: string;
  isLight?: boolean;
}

function buildGhostEfficiency(efficiency: number[], idx: number | null): number[] {
  if (idx === null || idx < 0 || idx >= efficiency.length) return efficiency;
  // Compute slope from last 10 points before intervention
  const window = efficiency.slice(Math.max(0, idx - 10), idx + 1);
  const slope = window.length >= 2
    ? (window[window.length - 1] - window[0]) / window.length
    : -0.15;
  const ghost = [...efficiency];
  const base = efficiency[idx];
  for (let i = idx + 1; i < ghost.length; i++) {
    // Without AI: continue degradation slope (typically steeper decline)
    ghost[i] = base + slope * (i - idx) * 1.8;
  }
  return ghost;
}

function buildGhostFlue(flueGasTemp: number[], idx: number | null): number[] {
  if (idx === null || idx < 0 || idx >= flueGasTemp.length) return flueGasTemp;
  const window = flueGasTemp.slice(Math.max(0, idx - 10), idx + 1);
  const slope = window.length >= 2
    ? (window[window.length - 1] - window[0]) / window.length
    : 0.3;
  const ghost = [...flueGasTemp];
  const base = flueGasTemp[idx];
  for (let i = idx + 1; i < ghost.length; i++) {
    ghost[i] = base + slope * (i - idx) * 1.8;
  }
  return ghost;
}

function makeCriticalLinePlugin(idxRef: React.MutableRefObject<number | null>, activeRef: React.MutableRefObject<boolean>) {
  return {
    id: 'criticalLine',
    afterDraw(chart: Chart) {
      if (!activeRef.current) return;
      const idx = idxRef.current;
      if (idx === null || idx < 0) return;
      const { ctx, chartArea, scales } = chart;
      const xScale = scales['x'];
      if (!xScale) return;
      const x = xScale.getPixelForValue(idx);
      if (x < chartArea.left || x > chartArea.right) return;

      ctx.save();

      // Shaded "Without AI" region after intervention
      ctx.fillStyle = 'rgba(239,68,68,0.07)';
      ctx.fillRect(x, chartArea.top, chartArea.right - x, chartArea.bottom - chartArea.top);

      // Shaded "With AI" region before
      ctx.fillStyle = 'rgba(34,197,94,0.05)';
      ctx.fillRect(chartArea.left, chartArea.top, x - chartArea.left, chartArea.bottom - chartArea.top);

      // Dividing line
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();

      // Labels above chart
      ctx.setLineDash([]);
      ctx.font = 'bold 8px sans-serif';
      ctx.fillStyle = 'rgba(34,197,94,0.85)';
      ctx.fillText('WITH AI ✓', chartArea.left + 4, chartArea.top + 12);
      ctx.fillStyle = 'rgba(239,68,68,0.85)';
      ctx.fillText('WITHOUT AI ✗', x + 4, chartArea.top + 12);

      ctx.restore();
    },
  };
}

export function BeforeAfterReplayChart({ efficiency, flueGasTemp, interventionRelIdx, interventionTimestamp, isLight }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const idxRef = useRef<number | null>(null);
  const activeRef = useRef(false);
  const [replayActive, setReplayActive] = useState(false);
  const grid = isLight ? '#e8ddd4' : '#2d3748';
  const tick = isLight ? '#9c8878' : '#94a3b8';

  useEffect(() => {
    if (!canvasRef.current) return;
    const plugin = makeCriticalLinePlugin(idxRef, activeRef);
    chartRef.current = new Chart(canvasRef.current, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          // Ghost (without AI) — red dashed
          {
            label: 'Without AI',
            borderColor: 'rgba(239,68,68,0.7)',
            borderDash: [4, 2],
            data: [],
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0.3,
            hidden: true,
          },
          // Actual (with AI) — green solid
          {
            label: 'With AI (actual)',
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
          tooltip: {
            mode: 'index',
            intersect: false,
            callbacks: {
              title: () => '',
              label: (item) => `${item.dataset.label}: ${(item.raw as number).toFixed(1)}%`,
            },
          },
        },
        scales: {
          x: { display: false },
          y: {
            grid: { color: grid },
            ticks: { color: tick, font: { size: 9 } },
            title: { display: true, text: 'Efficiency %', color: tick, font: { size: 8 } },
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
    activeRef.current = replayActive;

    const ghostEff = replayActive ? buildGhostEfficiency(efficiency, interventionRelIdx) : efficiency;

    c.data.labels = efficiency.map(() => '');
    c.data.datasets[0].data = ghostEff;
    c.data.datasets[0].hidden = !replayActive;
    c.data.datasets[1].data = efficiency;
    if (c.options.scales?.y?.grid) (c.options.scales.y.grid as { color: string }).color = grid;
    if (c.options.scales?.y?.ticks) (c.options.scales.y.ticks as { color: string }).color = tick;
    c.update('none');
  }, [efficiency, flueGasTemp, interventionRelIdx, isLight, replayActive]);

  const toggle = useCallback(() => {
    setReplayActive(prev => {
      activeRef.current = !prev;
      return !prev;
    });
  }, []);

  const hasIntervention = interventionRelIdx !== null && interventionRelIdx >= 0;
  const ghostEffAtEnd = efficiency.length > 0
    ? buildGhostEfficiency(efficiency, interventionRelIdx).at(-1)
    : null;
  const actualEffAtEnd = efficiency.at(-1);
  const effDelta = (ghostEffAtEnd != null && actualEffAtEnd != null)
    ? (actualEffAtEnd - ghostEffAtEnd).toFixed(1)
    : null;

  return (
    <div className="inner-card">
      <div className="flex justify-between items-center mb-2">
        <div className="text-[10px] font-semibold tracking-wider uppercase" style={{ color: 'var(--tx-label)' }}>
          Intervention Impact — With vs Without AI
        </div>
        <button
          onClick={toggle}
          disabled={!hasIntervention}
          className="text-[9px] font-bold px-2 py-1 rounded transition-all"
          style={{
            background: replayActive
              ? 'rgba(239,68,68,0.15)'
              : hasIntervention ? 'rgba(251,191,36,0.15)' : 'rgba(100,100,100,0.1)',
            border: replayActive
              ? '1px solid rgba(239,68,68,0.5)'
              : hasIntervention ? '1px solid rgba(251,191,36,0.5)' : '1px solid rgba(100,100,100,0.2)',
            color: replayActive ? '#f87171' : hasIntervention ? '#fbbf24' : 'var(--tx-muted)',
            cursor: hasIntervention ? 'pointer' : 'not-allowed',
          }}
        >
          {replayActive ? '■ Hide' : '▶ Without AI?'}
        </button>
      </div>

      <div className="relative h-[120px] w-full">
        <canvas ref={canvasRef} />
      </div>

      {replayActive && effDelta && (
        <div className="flex gap-2 mt-2">
          <div className="flex-1 rounded px-2 py-1 text-center" style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)' }}>
            <div className="text-[8px] font-medium" style={{ color: '#fca5a5' }}>Without AI</div>
            <div className="text-xs font-bold digit" style={{ color: '#f87171' }}>{ghostEffAtEnd?.toFixed(1)}%</div>
          </div>
          <div className="flex-1 rounded px-2 py-1 text-center" style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)' }}>
            <div className="text-[8px] font-medium" style={{ color: '#86efac' }}>With AI</div>
            <div className="text-xs font-bold digit" style={{ color: '#4ade80' }}>{actualEffAtEnd?.toFixed(1)}%</div>
          </div>
          <div className="flex-1 rounded px-2 py-1 text-center" style={{ background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.2)' }}>
            <div className="text-[8px] font-medium" style={{ color: '#fde68a' }}>Saved</div>
            <div className="text-xs font-bold digit" style={{ color: '#fbbf24' }}>+{effDelta}%</div>
          </div>
        </div>
      )}

      {!replayActive && !hasIntervention && (
        <div className="text-[9px] mt-1" style={{ color: 'var(--tx-muted)' }}>
          Button activates when AI detects an anomaly
        </div>
      )}

      {replayActive && interventionTimestamp && (
        <div className="text-[9px] mt-1" style={{ color: 'var(--tx-muted)' }}>
          Dashed line = projected path without AI, from the intervention · {interventionTimestamp}
        </div>
      )}
    </div>
  );
}
