'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useNexusStore } from '@/lib/store';
import { calcRisk, calcDerivedMetrics, formatEta } from '@/lib/utils';
import { vizPalette, toneColor } from '@/lib/vizPalette';
import { Sparkline } from '@/components/charts/Sparkline';
import { TrendTile } from '@/components/charts/TrendTile';
import { AlarmSummary } from '@/components/AlarmSummary';

type Status = 'ok' | 'warn' | 'crit' | 'neutral';
type Polarity = 'higher-better' | 'neutral';

interface KpiDef {
  label: string;
  unit: string;
  decimals: number;
  current: number | null;
  base: number | null;
  series: number[];
  status: Status;
  polarity: Polarity;
  reference: string;
}

function KpiCard({ k, isLight, onClick }: { k: KpiDef; isLight: boolean; onClick?: () => void }) {
  const valueStr = k.current != null ? k.current.toFixed(k.decimals) : '--';
  const pal = vizPalette(isLight);
  const statusHue = k.status === 'ok' ? pal.status.good
    : k.status === 'warn' ? pal.status.warn
    : k.status === 'crit' ? pal.status.crit
    : null;
  const borderColor = statusHue ?? 'var(--bd-inner)';
  const valueColor = k.status === 'warn' ? pal.status.warn : k.status === 'crit' ? pal.status.crit : 'var(--tx-primary)';
  const sparkColor = statusHue ?? '#64748b';

  let delta: React.ReactNode = null;
  if (k.current != null && k.base != null) {
    const d = k.current - k.base;
    const flatEps = k.decimals === 0 ? 1 : 0.05;
    const isFlat = Math.abs(d) < flatEps;
    const arrow = isFlat ? '▬' : d > 0 ? '▲' : '▼';
    let dColor = 'var(--tx-muted)';
    if (!isFlat && k.polarity === 'higher-better') dColor = d > 0 ? pal.status.good : pal.status.crit;
    delta = (
      <span style={{ fontSize: 12, fontWeight: 700, color: dColor, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
        {arrow} {d >= 0 ? '+' : ''}{d.toFixed(k.decimals)}
      </span>
    );
  }

  return (
    <div
      className="card"
      style={{ padding: 0, overflow: 'hidden', cursor: onClick ? 'pointer' : undefined, transition: 'opacity 0.15s' }}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); } : undefined}
    >
      <div style={{ height: 3, background: borderColor }} />
      <div style={{ padding: '13px 16px 14px', display: 'flex', flexDirection: 'column', gap: 9 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--tx-muted)' }}>
            {k.label}
          </div>
          {onClick && <span style={{ fontSize: 9, fontWeight: 600, color: 'var(--tx-muted)', opacity: 0.6, letterSpacing: '0.04em' }}>↗ INVESTIGATE</span>}
        </div>

        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ fontSize: 28, fontWeight: 900, letterSpacing: '-0.03em', color: valueColor, fontVariantNumeric: 'tabular-nums', display: 'flex', alignItems: 'baseline', gap: 4 }}>
            {valueStr}
            {valueStr !== '--' && <span style={{ fontSize: 12, fontWeight: 600, opacity: 0.6 }}>{k.unit}</span>}
          </div>
          {delta}
        </div>

        <Sparkline data={k.series} color={sparkColor} height={30} />

        <div style={{ fontSize: 10, color: 'var(--tx-muted)', fontWeight: 500 }}>{k.reference}</div>
      </div>
    </div>
  );
}

export default function OverviewPage() {
  const router = useRouter();
  const {
    tags, degradationFactor, mode, mqttStatus, anomalyScore, anomalyIsAnomaly,
    aiStatus, forecastDeadline, healthHistory, moiraiForecast, kpiSeries, kpiBaseline,
    riskSeries, anomalySeries, isLight,
  } = useNexusStore();
  const pal = vizPalette(isLight);

  const risk = tags ? calcRisk(tags, degradationFactor) : 0;
  const derived = useMemo(() => tags ? calcDerivedMetrics(tags) : null, [tags]);

  const latestHealth = healthHistory[healthHistory.length - 1]?.v;
  const firstHealth  = healthHistory[0]?.v;
  const healthDelta  = latestHealth != null && firstHealth != null ? latestHealth - firstHealth : 0;

  const etaText = useMemo(() => {
    if (!forecastDeadline) return 'No breach projected';
    const rem = forecastDeadline - Date.now() / 1000;
    return rem <= 0 ? 'Threshold breached' : formatEta(rem);
  }, [forecastDeadline]);

  const efficiencyLoss    = tags ? Math.max(0, 87 - tags.efficiency) : 0;
  const estimatedFuelLoss = tags && derived ? Math.max(0, efficiencyLoss * tags.fuel_flow * 0.12) : 0;

  const statusCards = [
    { label: 'Connection',     value: mqttStatus.toUpperCase(), tone: mqttStatus === 'connected' ? 'good' : 'bad' },
    { label: 'Operating Mode', value: mode,                     tone: mode === 'NORMAL' ? 'good' : mode === 'FAULT' ? 'bad' : 'warn' },
    { label: 'AI Analyst',     value: aiStatus === 'analyzing' ? 'ANALYZING' : 'ONLINE', tone: aiStatus === 'analyzing' ? 'warn' : 'good' },
    { label: 'Anomaly Score',  value: `${anomalyScore}%`,       tone: anomalyIsAnomaly ? 'bad' : anomalyScore > 55 ? 'warn' : 'good' },
    { label: 'Failure Risk',   value: `${risk}%`,               tone: risk > 70 ? 'bad' : risk > 40 ? 'warn' : 'good' },
  ];

  const kpiCards: KpiDef[] = [
    {
      label: 'Steam Pressure', unit: 'bar', decimals: 1,
      current: tags?.steam_pressure ?? null, base: kpiBaseline?.steam_pressure ?? null,
      series: kpiSeries.datasets[0], polarity: 'neutral', reference: 'Warn > 12 · Limit 13 bar',
      status: !tags ? 'neutral' : tags.steam_pressure > 13 ? 'crit' : tags.steam_pressure > 12 ? 'warn' : 'ok',
    },
    {
      label: 'Drum Level', unit: 'mm', decimals: 0,
      current: tags?.drum_level ?? null, base: kpiBaseline?.drum_level ?? null,
      series: kpiSeries.datasets[1], polarity: 'neutral', reference: 'Normal 280-600 · Crit <200/>720 mm',
      status: !tags ? 'neutral'
        : tags.drum_level < 200 || tags.drum_level > 720 ? 'crit'
        : tags.drum_level < 280 || tags.drum_level > 600 ? 'warn'
        : 'ok',
    },
    {
      label: 'Efficiency', unit: '%', decimals: 1,
      current: tags?.efficiency ?? null, base: kpiBaseline?.efficiency ?? null,
      series: kpiSeries.datasets[2], polarity: 'higher-better', reference: 'Target 85% · Min 82%',
      status: !tags ? 'neutral' : tags.efficiency < 75 ? 'crit' : tags.efficiency < 82 ? 'warn' : 'ok',
    },
    {
      label: 'Tube Health', unit: '%', decimals: 1,
      current: tags?.tube_health ?? null, base: kpiBaseline?.tube_health ?? null,
      series: kpiSeries.datasets[3], polarity: 'higher-better', reference: 'Inspect < 70%',
      status: !tags ? 'neutral' : tags.tube_health < 70 ? 'crit' : tags.tube_health < 80 ? 'warn' : 'ok',
    },
  ];

  return (
    <div className="page-body">

      {/* Status strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 10 }}>
        {statusCards.map(c => (
          <div key={c.label} style={{
            background: 'var(--bg-surface)', border: '1px solid var(--bd-card)',
            borderRadius: 10, padding: '14px 16px',
            display: 'flex', flexDirection: 'column', gap: 6, position: 'relative', overflow: 'hidden',
          }}>
            <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--tx-muted)' }}>
              {c.label}
            </span>
            <strong style={{ fontSize: 18, fontWeight: 800, color: toneColor(c.tone, isLight), fontVariantNumeric: 'tabular-nums' }}>
              {c.value}
            </strong>
            <span style={{ position: 'absolute', top: 14, right: 14, width: 8, height: 8, borderRadius: '50%', background: toneColor(c.tone, isLight), opacity: 0.85 }} />
          </div>
        ))}
      </div>

      {/* KPI cards with sparklines + deltas */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
        {kpiCards.map(k => <KpiCard key={k.label} k={k} isLight={isLight} onClick={() => router.push('/predictive')} />)}
      </div>

      {/* Health headline trend strip */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--tx-muted)', paddingLeft: 2 }}>
          Health Signals · last 60s
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 16 }}>
          <TrendTile label="Efficiency" unit="%" color={pal.status.good}
            value={tags ? tags.efficiency.toFixed(1) : '--'} data={kpiSeries.datasets[2]} />
          <TrendTile label="Failure Risk" unit="%" color={pal.status.crit}
            value={`${risk}`} data={riskSeries.datasets[0]} />
          <TrendTile label="Anomaly Score" unit="%" color={pal.factor.quality}
            value={`${anomalyScore}`} data={anomalySeries.datasets[0]} />
        </div>
      </div>

      {/* Active alarms */}
      <AlarmSummary />

      {/* Reliability + Efficiency */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className="card">
          <div className="card-header">
            <h2 style={{ fontSize: 15, fontWeight: 700, color: 'var(--tx-primary)', margin: 0 }}>Reliability Runway</h2>
            <p style={{ fontSize: 12, color: 'var(--tx-secondary)', marginTop: 3, marginBottom: 0 }}>
              {moiraiForecast ? `Forecast: ${moiraiForecast.backend}` : 'Hybrid trend projection'}
            </p>
          </div>
          <div className="card-content">
            <div className="kpi-row">
              <div><span>Tube Health</span><strong>{tags ? `${tags.tube_health.toFixed(1)}%` : '--'}</strong></div>
              <div><span>Threshold ETA</span><strong>{etaText}</strong></div>
              <div><span>Health Slope</span><strong>{`${healthDelta.toFixed(2)} pts`}</strong></div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h2 style={{ fontSize: 15, fontWeight: 700, color: 'var(--tx-primary)', margin: 0 }}>Efficiency Impact</h2>
            <p style={{ fontSize: 12, color: 'var(--tx-secondary)', marginTop: 3, marginBottom: 0 }}>Energy and emissions snapshot</p>
          </div>
          <div className="card-content">
            <div className="kpi-row">
              <div><span>Heat Rate</span><strong>{tags ? tags.heat_rate.toFixed(0) : '--'}</strong></div>
              <div><span>Recoverable Eff.</span><strong>{`${efficiencyLoss.toFixed(1)}%`}</strong></div>
              <div><span>Fuel Loss Est.</span><strong>{`${estimatedFuelLoss.toFixed(1)} m³/hr`}</strong></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
