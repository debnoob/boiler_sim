'use client';

import { useEffect, useRef } from 'react';
import { Chart, type ChartDataset } from 'chart.js/auto';
import type { HealthPoint, InterventionEvent } from '@/types/telemetry';

const MAX_HEALTH_HISTORY = 45;

interface Props {
  healthHistory: HealthPoint[];
  interventionEvents: InterventionEvent[];
  forecastDeadline: number | null;
  heartbeatCount: number;
  isLight?: boolean;
}

export function GhostLineChart({
  healthHistory,
  interventionEvents,
  forecastDeadline,
  heartbeatCount,
  isLight,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);

  const grid = isLight ? '#e8ddd4' : '#2d3748';
  const tick = isLight ? '#9c8878' : '#94a3b8';

  useEffect(() => {
    if (!canvasRef.current) return;
    chartRef.current = new Chart(canvasRef.current, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          // 0 — actual health (green solid)
          {
            label: 'Actual Tube Health',
            data: [],
            borderColor: '#22c55e',
            backgroundColor: 'transparent',
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.3,
            order: 1,
          } as ChartDataset<'line'>,
          // 1 — ghost "no action" trajectory (red dashed)
          {
            label: 'Without Autopilot',
            data: [],
            borderColor: '#ef4444',
            backgroundColor: 'transparent',
            borderWidth: 2,
            borderDash: [6, 4],
            pointRadius: 0,
            tension: 0.1,
            order: 2,
          } as ChartDataset<'line'>,
          // 2 — intervention marker (single dot)
          {
            label: 'AI Intervention',
            data: [],
            borderColor: '#fbbf24',
            backgroundColor: '#fbbf24',
            borderWidth: 0,
            pointRadius: 6,
            pointHoverRadius: 8,
            showLine: false,
            order: 0,
          } as ChartDataset<'line'>,
          // 3 — 70% threshold flat line
          {
            label: '70% Threshold',
            data: [],
            borderColor: 'rgba(239,68,68,0.5)',
            backgroundColor: 'transparent',
            borderWidth: 1.5,
            borderDash: [4, 4],
            pointRadius: 0,
            tension: 0,
            order: 3,
          } as ChartDataset<'line'>,
        ],
      },
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
                if (ctx.datasetIndex === 2) return 'AI intervention';
                if (ctx.datasetIndex === 3) return '70% inspection threshold';
                return `${ctx.dataset.label}: ${typeof ctx.raw === 'number' ? ctx.raw.toFixed(1) : ''}%`;
              },
            },
          },
        },
        scales: {
          x: { display: false },
          y: {
            min: 55,
            max: 105,
            grid: { color: grid },
            ticks: { color: tick, font: { size: 9 }, callback: (v) => `${v}%` },
          },
        },
      },
    });
    return () => { chartRef.current?.destroy(); };
  }, []);

  useEffect(() => {
    const c = chartRef.current;
    if (!c || healthHistory.length === 0) return;

    if (c.options.scales?.y?.grid) (c.options.scales.y.grid as any).color = grid;
    if (c.options.scales?.y?.ticks) (c.options.scales.y.ticks as any).color = tick;

    const labels = healthHistory.map((_, i) => String(i));
    const actualData = healthHistory.map((p) => p.v);

    // Find the last intervention and compute its index in the current healthHistory window
    const lastEvent = interventionEvents[interventionEvents.length - 1];
    let ghostData: (number | null)[] = Array(healthHistory.length).fill(null);
    let markerData: (number | null)[] = Array(healthHistory.length).fill(null);

    if (lastEvent && lastEvent.forecastDeadlineAtDetection != null) {
      const n_ago = heartbeatCount - lastEvent.heartbeatCountAtDetection;
      // Position in current history array (may be negative if scrolled out)
      const interventionIdx = healthHistory.length - 1 - n_ago;

      if (interventionIdx >= 0 && interventionIdx < healthHistory.length) {
        const interventionT = healthHistory[interventionIdx].t;
        const interventionHealth = lastEvent.tubeHealthAtEvent;

        // Pre-intervention slope: health was going from interventionHealth → 70
        // over forecastDeadlineAtDetection - interventionT seconds
        const remainingAtIntervention = lastEvent.forecastDeadlineAtDetection - interventionT;
        const preSlope = remainingAtIntervention > 0
          ? (interventionHealth - 70) / remainingAtIntervention
          : 0.02; // fallback: fast decline

        // Ghost from intervention forward
        ghostData = healthHistory.map((p, i) => {
          if (i < interventionIdx) return null;
          const dt = p.t - interventionT;
          return Math.max(55, interventionHealth - preSlope * dt);
        });

        // Marker dot at intervention point
        markerData = Array(healthHistory.length).fill(null);
        markerData[interventionIdx] = interventionHealth;
      }
    }

    const thresholdData = Array(healthHistory.length).fill(70);

    c.data.labels = labels;
    c.data.datasets[0].data = actualData;
    c.data.datasets[1].data = ghostData;
    c.data.datasets[2].data = markerData;
    c.data.datasets[3].data = thresholdData;
    c.update('none');
  }, [healthHistory, interventionEvents, heartbeatCount, forecastDeadline, isLight]);

  const lastEvent = interventionEvents[interventionEvents.length - 1];
  const savedHours = (() => {
    if (!lastEvent?.forecastDeadlineAtDetection || forecastDeadline == null) return null;
    const delta = forecastDeadline - lastEvent.forecastDeadlineAtDetection;
    if (delta <= 60) return null;
    const h = Math.floor(delta / 3600);
    const m = Math.floor((delta % 3600) / 60);
    return h > 0 ? `+${h}h ${m}m` : `+${m}m`;
  })();

  return (
    <div className="inner-card">
      <div className="chart-card-header">
        <div className="chart-card-title">Tube Health · Autopilot vs No-Action</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {savedHours && (
            <div className="status-pill ok">
              {savedHours} life extended
            </div>
          )}
          {lastEvent && (
            <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--tx-muted)' }}>
              {interventionEvents.length} intervention{interventionEvents.length !== 1 ? 's' : ''}
            </div>
          )}
        </div>
      </div>

      <div style={{ position: 'relative', height: 130 }}>
        {healthHistory.length < 5 && (
          <div className="loading-state" style={{ position: 'absolute', inset: 0 }}>
            <span className="loading-dot" />
            <span>Collecting health history</span>
          </div>
        )}
        <canvas ref={canvasRef} />
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 14, marginTop: 6, flexWrap: 'wrap' }}>
        <LegendItem color="#22c55e" dash={false} label="Actual (with autopilot)" />
        <LegendItem color="#ef4444" dash label="Ghost: no-action trajectory" />
        <LegendItem color="#fbbf24" dot label="AI intervention" />
        {!lastEvent && (
          <span style={{ fontSize: 9, color: 'var(--tx-muted)', fontStyle: 'italic' }}>
            Ghost line appears after first autopilot intervention
          </span>
        )}
      </div>
    </div>
  );
}

function LegendItem({ color, dash, dot, label }: { color: string; dash?: boolean; dot?: boolean; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      {dot ? (
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
      ) : (
        <div style={{
          width: 20, height: 2, background: dash ? 'transparent' : color, flexShrink: 0,
          borderTop: dash ? `2px dashed ${color}` : 'none',
        }} />
      )}
      <span style={{ fontSize: 9, color: 'var(--tx-label)', fontWeight: 500 }}>{label}</span>
    </div>
  );
}
