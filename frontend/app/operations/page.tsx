'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Chart as ChartJS, registerables, type ScriptableContext } from 'chart.js';
import { Doughnut, Bar } from 'react-chartjs-2';
import { useNexusStore } from '@/lib/store';
import { usePublish } from '@/lib/publishContext';
import { vizPalette, hexA, oeeColor as oeeColorFn, stateColor as stateColorFn } from '@/lib/vizPalette';
import type { OeeSnapshotPayload, DiagnosisPayload } from '@/types/telemetry';

ChartJS.register(...registerables);

const TOPIC_OEE_REQUEST = 'factory/pumphouse4/boiler/unit01/kpi/oee/request';
const OEE_TARGET_PCT = 85;
const STEAM_HOUR_WINDOW = 6;

const STATE_LABELS: Record<string, string> = {
  production: 'Production',
  slow: 'Slow',
  downtime: 'Downtime',
  critical: 'Critical',
  setup: 'Setup',
};

const pct = (v?: number) => (v == null || Number.isNaN(v) ? 0 : v * 100);
const fmtKg = (v?: number) =>
  v == null ? '--' : v >= 1000 ? `${(v / 1000).toFixed(1)} t` : `${Math.round(v)} kg`;
const fmtTime = (sec: number) =>
  new Date(sec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// Smoothly animate a number toward its target (ease-out cubic).
function useCountUp(target: number, duration = 550) {
  const [val, setVal] = useState(target);
  const fromRef = useRef(target);
  useEffect(() => {
    const from = fromRef.current;
    if (Math.abs(from - target) < 0.05) {
      fromRef.current = target;
      setVal(target);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setVal(from + (target - from) * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return val;
}

// ── Small building blocks ──────────────────────────────────────────
function Panel({
  title,
  subtitle,
  right,
  children,
  style,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div className="card" style={style}>
      <div className="ops-panel-header">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {right}
      </div>
      <div style={{ padding: '0 20px 18px' }}>{children}</div>
    </div>
  );
}

function Meter({
  value,
  target,
  color,
  height = 8,
}: {
  value: number;
  target: number;
  color: string;
  height?: number;
}) {
  return (
    <div
      style={{
        position: 'relative',
        height,
        borderRadius: 999,
        background: 'var(--bg-base)',
        border: '1px solid var(--bd-inner)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          width: `${Math.max(0, Math.min(100, value))}%`,
          background: `linear-gradient(90deg, ${hexA(color, 0.55)}, ${color})`,
          borderRadius: 999,
          transition: 'width 0.6s cubic-bezier(0.4,0,0.2,1)',
        }}
      />
      {target > 0 && (
        <div
          title={`Target ${target}%`}
          style={{
            position: 'absolute',
            top: -2,
            bottom: -2,
            left: `${Math.max(0, Math.min(100, target))}%`,
            width: 2,
            background: 'var(--tx-primary)',
            opacity: 0.5,
          }}
        />
      )}
    </div>
  );
}

// Tiny inline SVG sparkline (single series, theme-neutral stroke color passed in).
function Sparkline({ data, color, width = 84, height = 26 }: { data: number[]; color: string; width?: number; height?: number }) {
  if (data.length < 2) return <div style={{ width, height }} />;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pts = data.map((d, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - 4 - ((d - min) / span) * (height - 8);
    return [x, y] as const;
  });
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;
  const gid = `spk-${color.replace('#', '')}`;
  return (
    <svg width={width} height={height} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r={2.4} fill={color} />
    </svg>
  );
}

function FactorCard({
  label,
  value,
  target,
  sub,
  color,
  spark,
}: {
  label: string;
  value: number;
  target: number;
  sub: string;
  color: string;
  spark: number[];
}) {
  const shown = useCountUp(value);
  const gap = value - target;
  const tone = value >= target ? 'ok' : value >= target - 8 ? 'warn' : 'crit';
  return (
    <div className="inner-card factor-card" style={{ display: 'flex', flexDirection: 'column', gap: 9, ['--factor-hue' as string]: color }}>
      <div className="chart-card-header" style={{ marginBottom: 2 }}>
        <div className="chart-card-title">{label}</div>
        <span className={`status-pill ${tone}`}>
          {gap >= 0 ? '+' : ''}
          {gap.toFixed(0)} pts vs tgt
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 3 }}>
          <span className="digit val-highlight" style={{ fontSize: 32, fontWeight: 900, color, lineHeight: 1 }}>
            {shown.toFixed(0)}
          </span>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--tx-label)' }}>%</span>
        </div>
        <Sparkline data={spark} color={color} />
      </div>
      <Meter value={value} target={target} color={color} />
      <div style={{ fontSize: 10.5, color: 'var(--tx-secondary)', lineHeight: 1.35 }}>{sub}</div>
    </div>
  );
}

function StatusTimeline({
  segments,
  live,
  stateColor,
}: {
  segments: Array<{ state: string; start: number; end: number }>;
  live: boolean;
  stateColor: (s: string) => string;
}) {
  if (!segments.length) {
    return <div className="loading-state">No status timeline for this shift yet.</div>;
  }
  const start = segments[0].start;
  const end = segments[segments.length - 1].end;
  const total = Math.max(1, end - start);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => start + f * total);
  const present = Array.from(new Set(segments.map((s) => s.state)));
  return (
    <div>
      <div
        style={{
          position: 'relative',
          display: 'flex',
          height: 40,
          borderRadius: 8,
          overflow: 'hidden',
          border: '1px solid var(--bd-inner)',
          background: 'var(--bg-base)',
          boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.18)',
        }}
      >
        {segments.map((s, i) => {
          const w = ((s.end - s.start) / total) * 100;
          if (w <= 0) return null;
          return (
            <div
              key={i}
              title={`${STATE_LABELS[s.state] ?? s.state} · ${fmtTime(s.start)}–${fmtTime(s.end)}`}
              style={{
                width: `${w}%`,
                background: stateColor(s.state),
                boxShadow: 'inset -1px 0 0 rgba(0,0,0,0.16)',
              }}
            />
          );
        })}
        {live && (
          <div
            title="Now"
            style={{
              position: 'absolute',
              right: 0,
              top: -2,
              bottom: -2,
              width: 2,
              background: 'var(--tx-primary)',
              boxShadow: '0 0 8px rgba(255,255,255,0.6)',
            }}
          />
        )}
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginTop: 6,
          fontSize: 9.5,
          color: 'var(--tx-muted)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {ticks.map((t, i) => (
          <span key={i}>{fmtTime(t)}</span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        {present.map((st) => (
          <span
            key={st}
            className="status-pill"
            style={{ borderColor: hexA(stateColor(st), 0.4), background: hexA(stateColor(st), 0.1), color: 'var(--tx-secondary)' }}
          >
            <span style={{ width: 8, height: 8, borderRadius: 2, background: stateColor(st) }} />
            {STATE_LABELS[st] ?? st}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────
export default function OperationsPage() {
  const {
    tags,
    mode,
    mqttStatus,
    anomalyScore,
    alerts,
    oeeSnapshot,
    oeeHistory,
    statusTimeline,
    steamHourlySeries,
    chatMessages,
    isLight,
  } = useNexusStore();
  const publish = usePublish();

  const [selKey, setSelKey] = useState<string | null>(null);

  useEffect(() => {
    publish(TOPIC_OEE_REQUEST, { limit: 7 });
  }, [publish]);

  // ── Theme-aware, validated palette (shared with Overview) ──
  const P = vizPalette(isLight);
  const F = P.factor;
  const S = P.status;
  const stateColor = (st: string) => stateColorFn(st, isLight);
  const oeeColor = (o: number) => oeeColorFn(o, isLight);
  const trackColor = P.track;
  const tickColor = P.tick;
  const gridColor = P.grid;

  const shifts = useMemo(() => oeeHistory.filter((s) => s && !s.empty), [oeeHistory]);
  const currentSnap: OeeSnapshotPayload | null = oeeSnapshot ?? shifts[0] ?? null;
  const currentStart = currentSnap?.shift_start ?? null;
  const activeStart = selKey ?? currentStart;
  const selIdx = shifts.findIndex((s) => s.shift_start === activeStart);
  const selected = (selIdx >= 0 ? shifts[selIdx] : currentSnap) ?? currentSnap;
  const isCurrent = activeStart === currentStart;
  const prevShift = selIdx >= 0 ? shifts[selIdx + 1] : shifts[1];

  const oee = selected?.oee ?? {};
  const oeePct = pct(oee.oee);
  const availPct = pct(oee.availability);
  const thermalPct = pct(oee.performance);
  const qualityPct = pct(oee.quality);
  const avgEff = oee.avg_efficiency_pct ?? selected?.efficiency?.end ?? 0;
  const ratedEff = oee.rated_efficiency_pct ?? 87;

  const actualSteam = oee.actual_steam_kg ?? 0;
  const targetSteam = oee.rated_steam_kg ?? oee.available_steam_kg ?? 0;
  const steamDelta = actualSteam - targetSteam;

  const alertCount = selected?.alerts
    ? Object.values(selected.alerts).reduce((a, b) => a + (b || 0), 0)
    : alerts.length;
  const anomalyEvents = selected?.anomaly_events ?? 0;
  const steamFuel = tags && tags.fuel_flow > 0 ? tags.steam_flow / tags.fuel_flow : 0;
  const timelineSegments = isCurrent ? statusTimeline : selected?.status_timeline ?? [];

  const latestDiag = [...chatMessages].reverse().find((m) => m.type === 'diagnosis');
  const diag = latestDiag?.data as DiagnosisPayload | undefined;

  const donutColor = oeeColor(oeePct);
  const shownOee = useCountUp(oeePct);
  const oeeDelta = prevShift?.oee?.oee != null ? oeePct - pct(prevShift.oee.oee) : null;

  // Per-factor history (oldest→newest) for the sparklines.
  const chrono = useMemo(() => [...shifts].reverse(), [shifts]);
  const availSpark = chrono.map((s) => pct(s.oee?.availability));
  const thermalSpark = chrono.map((s) => pct(s.oee?.performance));
  const qualitySpark = chrono.map((s) => pct(s.oee?.quality));

  const hasData = currentSnap != null;

  // ── Steam per Hour chart ──
  // Show the most recent accumulated hourly buckets as-is. Anchoring a fixed
  // window to the current wall-clock hour made earlier hours drop out (they
  // failed the hourKey lookup and rendered as empty bars), so window over the
  // real series instead — previously produced hours stay visible.
  // Always lay out a fixed 6-hour grid so bars sit in consistent, side-by-side
  // columns. When fewer than 6 real buckets exist, pad the leading slots with
  // zero-value placeholders (anchored to consecutive hour keys) instead of
  // letting Chart.js stretch a couple of bars across the whole width.
  const steamHourWindow = useMemo(() => {
    const real = steamHourlySeries.slice(-STEAM_HOUR_WINDOW);
    if (real.length >= STEAM_HOUR_WINDOW) return real;
    if (real.length === 0) return real;
    const anchorKey = real[real.length - 1].hourKey;
    const byKey = new Map(real.map((b) => [b.hourKey, b]));
    const grid: typeof real = [];
    for (let i = STEAM_HOUR_WINDOW - 1; i >= 0; i--) {
      const hourKey = anchorKey - i;
      const existing = byKey.get(hourKey);
      if (existing) {
        grid.push(existing);
      } else {
        const label = new Date(hourKey * 3600 * 1000).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        });
        grid.push({ hourKey, label, kg: 0, samples: 0 });
      }
    }
    return grid;
  }, [steamHourlySeries]);

  const steamHourData = {
    labels: steamHourWindow.map((b) => b.label),
    datasets: [
      {
        label: 'Steam (kg)',
        data: steamHourWindow.map((b) => Math.round(b.kg)),
        backgroundColor: (ctx: ScriptableContext<'bar'>) => {
          const area = ctx.chart.chartArea;
          if (!area) return F.thermal;
          const g = ctx.chart.ctx.createLinearGradient(0, area.bottom, 0, area.top);
          g.addColorStop(0, hexA(F.thermal, 0.2));
          g.addColorStop(1, F.thermal);
          return g;
        },
        hoverBackgroundColor: F.thermal,
        borderRadius: 4,
        categoryPercentage: 0.9,
        barPercentage: 0.8,
        maxBarThickness: 48,
      },
    ],
  };
  const barBaseOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 400 } as const,
    plugins: { legend: { display: false }, tooltip: { enabled: true } },
    scales: {
      x: { grid: { display: false }, border: { display: false }, ticks: { color: tickColor, font: { size: 10 } } },
      y: {
        beginAtZero: true,
        border: { display: false },
        grid: { color: gridColor, drawTicks: false },
        ticks: { color: tickColor, font: { size: 10 }, padding: 6 },
      },
    },
  };

  return (
    <div className="page-body">
      {/* ── Top strip ─────────────────────────────────────────── */}
      <div className="ops-status-strip">
        <div className="ops-status good">
          <span>Shift</span>
          <strong style={{ fontSize: 13 }}>{selected?.shift_label ?? 'Current Shift'}</strong>
        </div>
        <div className={`ops-status ${mqttStatus === 'connected' ? 'good' : 'bad'}`}>
          <span>Live Feed</span>
          <strong style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <span
              className={mqttStatus === 'connected' ? 'pulse-dot' : ''}
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: mqttStatus === 'connected' ? S.good : S.crit,
                boxShadow: mqttStatus === 'connected' ? `0 0 6px ${hexA(S.good, 0.6)}` : 'none',
              }}
            />
            {mqttStatus === 'connected' ? 'MQTT Live' : mqttStatus.toUpperCase()}
          </strong>
        </div>
        <div className={`ops-status ${mode === 'NORMAL' ? 'good' : mode === 'DEGRADING' ? 'warn' : 'bad'}`}>
          <span>Operating Mode</span>
          <strong style={{ fontSize: 13 }}>{mode}</strong>
        </div>
        <div className={`ops-status ${alertCount > 0 ? 'warn' : 'good'}`}>
          <span>Active Alerts</span>
          <strong>{alertCount}</strong>
        </div>
        <div className={`ops-status ${anomalyScore > 0.6 ? 'bad' : anomalyScore > 0.3 ? 'warn' : 'good'}`}>
          <span>Anomaly Score</span>
          <strong>{anomalyScore.toFixed(2)}</strong>
        </div>
      </div>

      {!hasData ? (
        <>
          <div className="ops-eyebrow">Effectiveness</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.05fr) minmax(0,1fr)', gap: 16 }}>
            <div className="skeleton" style={{ height: 320 }} />
            <div style={{ display: 'grid', gap: 12 }}>
              <div className="skeleton" style={{ height: 98 }} />
              <div className="skeleton" style={{ height: 98 }} />
              <div className="skeleton" style={{ height: 98 }} />
            </div>
          </div>
          <div className="loading-state">
            <span className="loading-dot" />
            Waiting for OEE data from the AI analyst…
          </div>
        </>
      ) : (
        <>
          {/* ══ Effectiveness ══ */}
          <div className="ops-eyebrow">Effectiveness</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.05fr) minmax(0,1fr)', gap: 16 }}>
            <Panel
              title="OEE — Current Shift"
              subtitle="Availability × Thermal Performance × Steam Quality"
              right={<span className="audit-pill">{isCurrent ? 'LIVE' : 'HISTORICAL'}</span>}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap' }}>
                <div style={{ position: 'relative', width: 220, height: 220, flexShrink: 0 }}>
                  {/* status halo */}
                  <div
                    style={{
                      position: 'absolute',
                      inset: 20,
                      borderRadius: '50%',
                      background: `radial-gradient(circle, ${hexA(donutColor, isLight ? 0.14 : 0.22)}, transparent 68%)`,
                      filter: 'blur(6px)',
                      pointerEvents: 'none',
                    }}
                  />
                  <Doughnut
                    data={{
                      datasets: [
                        {
                          data: [oeePct, Math.max(0, 100 - oeePct)],
                          backgroundColor: (ctx: ScriptableContext<'doughnut'>) => {
                            if (ctx.dataIndex !== 0) return trackColor;
                            const area = ctx.chart.chartArea;
                            if (!area) return donutColor;
                            const g = ctx.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
                            g.addColorStop(0, hexA(donutColor, 0.7));
                            g.addColorStop(1, donutColor);
                            return g;
                          },
                          borderWidth: 0,
                          borderRadius: 20,
                          spacing: 2,
                          circumference: 360,
                          rotation: 0,
                        },
                      ],
                    }}
                    options={{
                      cutout: '76%',
                      animation: { duration: 500 },
                      plugins: { legend: { display: false }, tooltip: { enabled: false } },
                      maintainAspectRatio: false,
                    }}
                  />
                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      pointerEvents: 'none',
                    }}
                  >
                    <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.14em', color: 'var(--tx-muted)' }}>
                      OEE
                    </span>
                    <span
                      className="digit val-highlight"
                      style={{ fontSize: 50, fontWeight: 900, color: donutColor, lineHeight: 1, letterSpacing: '-0.02em' }}
                    >
                      {shownOee.toFixed(0)}
                      <span style={{ fontSize: 20 }}>%</span>
                    </span>
                    {oeeDelta != null ? (
                      <span
                        className="ops-delta-chip"
                        style={{
                          marginTop: 6,
                          color: oeeDelta >= 0 ? S.good : S.crit,
                          borderColor: hexA(oeeDelta >= 0 ? S.good : S.crit, 0.35),
                          background: hexA(oeeDelta >= 0 ? S.good : S.crit, 0.1),
                        }}
                      >
                        {oeeDelta >= 0 ? '▲' : '▼'} {Math.abs(oeeDelta).toFixed(1)} pts vs prev
                      </span>
                    ) : (
                      <span style={{ fontSize: 10, color: 'var(--tx-muted)', marginTop: 6 }}>Target {OEE_TARGET_PCT}%</span>
                    )}
                  </div>
                </div>
                <div style={{ flex: 1, minWidth: 190, display: 'grid', gap: 12 }}>
                  {[
                    { k: 'Availability', v: availPct, c: F.avail },
                    { k: 'Thermal Performance', v: thermalPct, c: F.thermal },
                    { k: 'Steam Quality', v: qualityPct, c: F.quality },
                  ].map((row) => (
                    <div key={row.k}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 5 }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--tx-secondary)', fontWeight: 700 }}>
                          <span style={{ width: 9, height: 9, borderRadius: 3, background: row.c }} />
                          {row.k}
                        </span>
                        <span className="digit" style={{ color: 'var(--tx-primary)', fontWeight: 800 }}>
                          {row.v.toFixed(0)}%
                        </span>
                      </div>
                      <Meter value={row.v} target={0} color={row.c} height={7} />
                    </div>
                  ))}
                </div>
              </div>
            </Panel>

            <div style={{ display: 'grid', gap: 12, gridTemplateRows: 'repeat(3, 1fr)' }}>
              <FactorCard
                label="Availability"
                value={availPct}
                target={95}
                color={F.avail}
                spark={availSpark}
                sub={`Uptime ${(selected?.uptime_pct ?? 0).toFixed(0)}% · ${anomalyEvents} anomaly events this shift`}
              />
              <FactorCard
                label="Thermal Performance"
                value={thermalPct}
                target={100}
                color={F.thermal}
                spark={thermalSpark}
                sub={`Avg efficiency ${avgEff.toFixed(1)}% / rated ${ratedEff.toFixed(0)}%`}
              />
              <FactorCard
                label="Steam Quality"
                value={qualityPct}
                target={98}
                color={F.quality}
                spark={qualitySpark}
                sub={`In-spec steam ${fmtKg(oee.good_steam_kg)} of ${fmtKg(oee.actual_steam_kg)} produced`}
              />
            </div>
          </div>

          {/* ══ Production ══ */}
          <div className="ops-eyebrow">Production</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <Panel title="Steam per Hour" subtitle="Live production, kg per clock hour">
              <div style={{ height: 200 }}>
                {steamHourlySeries.length ? (
                  <Bar data={steamHourData} options={barBaseOptions} />
                ) : (
                  <div className="skeleton" style={{ height: '100%' }} />
                )}
              </div>
            </Panel>

            <Panel
              title="Historical Shift OEE"
              subtitle="Select a shift to drill into its factors and timeline"
              right={
                <button
                  onClick={() => {
                    publish(TOPIC_OEE_REQUEST, { limit: 7 });
                    setSelKey(null);
                  }}
                  style={{
                    cursor: 'pointer',
                    border: '1px solid var(--bd-inner)',
                    background: 'var(--bg-elevated)',
                    color: 'var(--tx-secondary)',
                    borderRadius: 6,
                    padding: '4px 10px',
                    fontSize: 10,
                    fontWeight: 800,
                  }}
                >
                  ⟳ Refresh
                </button>
              }
            >
              {shifts.length ? (
                <div style={{ position: 'relative', height: 200, paddingTop: 8 }}>
                  {/* target reference line */}
                  <div
                    style={{
                      position: 'absolute',
                      left: 0,
                      right: 0,
                      bottom: `calc(24px + ${OEE_TARGET_PCT * 0.62}%)`,
                      borderTop: '1px dashed var(--bd-inner)',
                      pointerEvents: 'none',
                    }}
                  >
                    <span style={{ position: 'absolute', right: 0, top: -14, fontSize: 9, color: 'var(--tx-muted)', fontWeight: 700 }}>
                      TGT {OEE_TARGET_PCT}%
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, height: '100%' }}>
                    {chrono.map((s) => {
                      const o = pct(s.oee?.oee);
                      const active = s.shift_start === activeStart;
                      const c = oeeColor(o);
                      return (
                        <div
                          key={s.shift_start}
                          onClick={() => setSelKey(s.shift_start === currentStart ? null : s.shift_start ?? null)}
                          title={`${s.shift_label}\nOEE ${o.toFixed(0)}% · Availability ${pct(s.oee?.availability).toFixed(0)}% · Thermal ${pct(s.oee?.performance).toFixed(0)}% · Quality ${pct(s.oee?.quality).toFixed(0)}%`}
                          style={{
                            flex: 1,
                            minWidth: 0,
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'flex-end',
                            gap: 6,
                            height: '100%',
                            cursor: 'pointer',
                          }}
                        >
                          <span className="digit" style={{ fontSize: 11, fontWeight: 800, color: active ? c : 'var(--tx-secondary)' }}>
                            {o.toFixed(0)}%
                          </span>
                          <div
                            style={{
                              width: '100%',
                              height: `${Math.max(4, o * 0.62)}%`,
                              background: active ? `linear-gradient(180deg, ${hexA(c, 0.85)}, ${c})` : hexA(c, 0.42),
                              borderRadius: '6px 6px 0 0',
                              border: active ? `1.5px solid ${c}` : '1.5px solid transparent',
                              boxShadow: active ? `0 0 14px ${hexA(c, 0.45)}` : 'none',
                              transition: 'height 0.5s cubic-bezier(0.4,0,0.2,1), opacity 0.2s, background 0.2s',
                            }}
                          />
                          <span
                            style={{
                              fontSize: 9,
                              color: active ? 'var(--tx-primary)' : 'var(--tx-muted)',
                              fontWeight: active ? 800 : 600,
                              textAlign: 'center',
                              lineHeight: 1.1,
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              maxWidth: '100%',
                            }}
                          >
                            {(s.shift_label ?? '').split(' ')[0]}
                            {s.shift_start === currentStart ? ' •' : ''}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="skeleton" style={{ height: 200 }} />
              )}
            </Panel>
          </div>

          {/* OEE factor table */}
          <Panel
            title="OEE Factor Detail"
            subtitle={`${selected?.shift_label ?? 'Current Shift'} · ${selected?.shift_duration ?? ''}`}
            right={<span className="audit-pill">{isCurrent ? 'LIVE SHIFT' : 'SELECTED SHIFT'}</span>}
          >
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--tx-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    <th style={{ padding: '8px 10px', fontWeight: 800 }}>Factor</th>
                    <th style={{ padding: '8px 10px', fontWeight: 800, textAlign: 'right' }}>Actual</th>
                    <th style={{ padding: '8px 10px', fontWeight: 800, textAlign: 'right' }}>Target</th>
                    <th style={{ padding: '8px 10px', fontWeight: 800, textAlign: 'right' }}>Gap</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { f: 'Availability', a: availPct, t: 95, c: F.avail },
                    { f: 'Thermal Performance', a: thermalPct, t: 100, c: F.thermal },
                    { f: 'Steam Quality', a: qualityPct, t: 98, c: F.quality },
                    { f: 'Avg Efficiency', a: avgEff, t: ratedEff, c: 'var(--tx-muted)' },
                    { f: 'OEE', a: oeePct, t: OEE_TARGET_PCT, c: donutColor },
                  ].map((r) => {
                    const gap = r.a - r.t;
                    const gc = gap >= 0 ? S.good : gap >= -8 ? S.warn : S.crit;
                    return (
                      <tr key={r.f} style={{ borderTop: '1px solid var(--bd-inner)' }}>
                        <td style={{ padding: '9px 10px', color: 'var(--tx-primary)', fontWeight: r.f === 'OEE' ? 900 : 600 }}>
                          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: r.c, marginRight: 8, verticalAlign: 'middle' }} />
                          {r.f}
                        </td>
                        <td className="digit" style={{ padding: '9px 10px', textAlign: 'right', color: 'var(--tx-primary)', fontWeight: 800 }}>
                          {r.a.toFixed(1)}%
                        </td>
                        <td className="digit" style={{ padding: '9px 10px', textAlign: 'right', color: 'var(--tx-secondary)' }}>
                          {r.t}%
                        </td>
                        <td className="digit" style={{ padding: '9px 10px', textAlign: 'right', color: gc, fontWeight: 800 }}>
                          {gap >= 0 ? '+' : ''}
                          {gap.toFixed(1)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>

          {/* Timeline */}
          <Panel
            title="Shift Status Timeline"
            subtitle={isCurrent ? 'Live operating state, this shift' : `Operating state · ${selected?.shift_label ?? ''}`}
          >
            <StatusTimeline segments={timelineSegments} live={isCurrent} stateColor={stateColor} />
          </Panel>

          {/* ══ Diagnostics ══ */}
          <div className="ops-eyebrow">Diagnostics</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
            <Panel title="Target vs Actual Steam" subtitle="This shift">
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                <span
                  className="digit val-highlight"
                  style={{ fontSize: 34, fontWeight: 900, color: steamDelta >= 0 ? S.good : S.crit }}
                >
                  {steamDelta >= 0 ? '▲' : '▼'} {fmtKg(Math.abs(steamDelta))}
                </span>
              </div>
              <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                  <span style={{ color: 'var(--tx-secondary)' }}>Target (rated)</span>
                  <strong className="digit" style={{ color: 'var(--tx-primary)' }}>{fmtKg(targetSteam)}</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                  <span style={{ color: 'var(--tx-secondary)' }}>Actual</span>
                  <strong className="digit" style={{ color: 'var(--tx-primary)' }}>{fmtKg(actualSteam)}</strong>
                </div>
                <Meter
                  value={targetSteam > 0 ? (actualSteam / targetSteam) * 100 : 0}
                  target={0}
                  color={steamDelta >= 0 ? S.good : S.warn}
                />
              </div>
            </Panel>

            <Panel title="Steam / Fuel" subtitle="Live energy effectiveness">
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span className="digit val-highlight" style={{ fontSize: 34, fontWeight: 900, color: F.thermal }}>
                  {steamFuel > 0 ? steamFuel.toFixed(1) : '--'}
                </span>
                <span style={{ fontSize: 12, color: 'var(--tx-muted)', fontWeight: 700 }}>kg steam / m³ fuel</span>
              </div>
              <div className="kpi-row" style={{ marginTop: 14, gridTemplateColumns: '1fr 1fr' }}>
                <div>
                  <span>Steam Flow</span>
                  <strong>{tags ? `${tags.steam_flow.toFixed(0)}` : '--'}</strong>
                </div>
                <div>
                  <span>Fuel Flow</span>
                  <strong>{tags ? `${tags.fuel_flow.toFixed(1)}` : '--'}</strong>
                </div>
              </div>
            </Panel>

            <Panel title="Latest AI Diagnosis" subtitle="From the reliability analyst">
              {diag ? (
                <div style={{ display: 'grid', gap: 9 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span
                      style={{
                        color: '#fff',
                        borderRadius: 4,
                        padding: '3px 7px',
                        fontSize: 9,
                        fontWeight: 900,
                        textTransform: 'uppercase',
                        background:
                          diag.severity === 'CRITICAL' || diag.severity === 'HIGH'
                            ? S.crit
                            : diag.severity === 'WARNING'
                            ? S.warn
                            : F.avail,
                      }}
                    >
                      {diag.severity ?? 'INFO'}
                    </span>
                    <strong style={{ color: 'var(--tx-primary)', fontSize: 13, lineHeight: 1.3 }}>
                      {diag.probable_cause ?? 'Diagnosis available'}
                    </strong>
                  </div>
                  {diag.explanation && (
                    <p style={{ margin: 0, color: 'var(--tx-secondary)', fontSize: 11.5, lineHeight: 1.5 }}>
                      {diag.explanation}
                    </p>
                  )}
                  {typeof diag.recommended_action === 'string' && (
                    <div className="operator-action">
                      <span>Recommended Action</span>
                      <p style={{ margin: 0, color: 'var(--tx-primary)', fontSize: 11.5, lineHeight: 1.45 }}>
                        {diag.recommended_action}
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="empty-incident">
                  <strong>No active diagnosis</strong>
                  <span>The analyst will surface a diagnosis here when an anomaly is detected.</span>
                </div>
              )}
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}
