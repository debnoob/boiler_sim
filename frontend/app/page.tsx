'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, Bot, Gauge, Radio, ShieldCheck, TrendingUp, TriangleAlert } from 'lucide-react';
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
      className="card ov-kpi-card"
      style={{ ['--kpi-accent' as string]: borderColor, cursor: onClick ? 'pointer' : undefined }}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); } : undefined}
    >
      <div className="ov-kpi-rail" />
      <div className="ov-kpi-content">
        <div className="ov-kpi-topline">
          <div className="ov-kpi-label">
            {k.label}
          </div>
          <span className={`ov-state-chip ${k.status}`}>{k.status === 'ok' ? 'Normal' : k.status === 'warn' ? 'Watch' : k.status === 'crit' ? 'Limit' : 'Waiting'}</span>
        </div>

        <div className="ov-kpi-value-row">
          <div className="ov-kpi-value" style={{ color: valueColor }}>
            {valueStr}
            {valueStr !== '--' && <span className="ov-kpi-unit">{k.unit}</span>}
          </div>
          {delta}
        </div>

        <div className="ov-kpi-spark">
          <Sparkline data={k.series} color={sparkColor} height={34} />
        </div>

        <div className="ov-kpi-ref">{k.reference}</div>
      </div>
    </div>
  );
}

function SystemTile({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  label: string;
  value: string;
  tone: 'good' | 'warn' | 'bad';
}) {
  return (
    <div className={`ov-system-tile ${tone}`}>
      <div className="ov-system-icon"><Icon size={15} strokeWidth={2.2} /></div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
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

  const statusCards: Array<{
    label: string;
    value: string;
    tone: 'good' | 'warn' | 'bad';
    icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  }> = [
    { label: 'MQTT', value: mqttStatus.toUpperCase(), tone: mqttStatus === 'connected' ? 'good' : 'bad', icon: Radio },
    { label: 'Mode', value: mode, tone: mode === 'NORMAL' ? 'good' : mode === 'FAULT' ? 'bad' : 'warn', icon: Gauge },
    { label: 'AI', value: aiStatus === 'analyzing' ? 'ANALYZING' : 'ONLINE', tone: aiStatus === 'analyzing' ? 'warn' : 'good', icon: Bot },
    { label: 'Anomaly', value: `${anomalyScore}%`, tone: anomalyIsAnomaly ? 'bad' : anomalyScore > 55 ? 'warn' : 'good', icon: ShieldCheck },
    { label: 'Risk', value: `${risk}%`, tone: risk > 70 ? 'bad' : risk > 40 ? 'warn' : 'good', icon: TriangleAlert },
  ];

  const headlineTone = mode === 'FAULT' || anomalyIsAnomaly || risk > 70 ? 'bad' : risk > 40 || aiStatus === 'analyzing' || anomalyScore > 55 ? 'warn' : 'good';
  const headline = headlineTone === 'bad'
    ? 'Boiler Unit 01 requires operator attention'
    : headlineTone === 'warn'
      ? 'Boiler Unit 01 operating with elevated watch conditions'
      : 'Boiler Unit 01 nominal - no breach projected';

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
    <div className="page-body overview-page">

      {/* Operational headline */}
      <div className={`ov-headline ${headlineTone}`}>
        <div className="ov-headline-main">
          <span className="ov-live-dot" style={{ background: toneColor(headlineTone, isLight), boxShadow: `0 0 12px ${toneColor(headlineTone, isLight)}66` }} />
          <div>
            <h2>{headline}</h2>
            <p>
              Mode {mode} · AI {aiStatus === 'analyzing' ? 'analyzing' : 'online'} · anomaly {anomalyScore}% · risk {risk}%
            </p>
          </div>
        </div>
        <div className="ov-headline-kpis">
          <div><span>Pressure</span><strong>{tags ? `${tags.steam_pressure.toFixed(1)} bar` : '--'}</strong></div>
          <div><span>Efficiency</span><strong>{tags ? `${tags.efficiency.toFixed(1)}%` : '--'}</strong></div>
          <div><span>ETA</span><strong>{etaText}</strong></div>
        </div>
      </div>

      {/* KPI cards with sparklines + deltas */}
      <div className="ov-kpi-row">
        {kpiCards.map(k => <KpiCard key={k.label} k={k} isLight={isLight} onClick={() => router.push('/predictive')} />)}
      </div>

      {/* Command summary band */}
      <div className="ov-command-grid">
        <section className="card ov-system-panel">
          <div className="ov-section-head">
            <div>
              <h2>System Matrix</h2>
              <p>Live state and controls</p>
            </div>
          </div>
          <div className="ov-system-grid">
            {statusCards.map(c => (
              <SystemTile key={c.label} icon={c.icon} label={c.label} value={c.value} tone={c.tone} />
            ))}
          </div>
        </section>

        <section className="card ov-trend-panel">
          <div className="ov-section-head">
            <div>
              <h2>Health Signals</h2>
              <p>Last 60 seconds</p>
            </div>
            <span className="audit-pill">Live</span>
          </div>
          <div className="ov-trend-grid">
            <TrendTile label="Steam Pressure" unit="bar" color={pal.status.warn}
              value={tags ? tags.steam_pressure.toFixed(1) : '--'} data={kpiSeries.datasets[0]} />
            <TrendTile label="Failure Risk" unit="%" color={pal.status.crit}
              value={`${risk}`} data={riskSeries.datasets[0]} />
            <TrendTile label="Anomaly Score" unit="%" color={pal.factor.quality}
              value={`${anomalyScore}`} data={anomalySeries.datasets[0]} />
          </div>
        </section>
      </div>

      {/* Active alarms as event feed */}
      <AlarmSummary />

      {/* Reliability + Efficiency */}
      <div className="ov-lower-grid">
        <div className="card ov-runway-panel">
          <div className="ov-section-head">
            <div>
              <h2>Reliability Runway</h2>
              <p>{moiraiForecast ? `Forecast: ${moiraiForecast.backend}` : 'Hybrid trend projection'}</p>
            </div>
            <Activity size={17} color="var(--tx-secondary)" />
          </div>
          <div className="ov-runway-content">
            <div className="ov-runway-metrics">
              <div><span>Tube Health</span><strong>{tags ? `${tags.tube_health.toFixed(1)}%` : '--'}</strong></div>
              <div><span>Threshold ETA</span><strong>{etaText}</strong></div>
              <div><span>Health Slope</span><strong>{`${healthDelta.toFixed(2)} pts`}</strong></div>
            </div>
            <div className="ov-runway-track" aria-hidden="true">
              <span className="ov-runway-fill" style={{ width: `${Math.max(0, Math.min(100, latestHealth ?? 0))}%` }} />
              <i style={{ left: '70%' }}><b>Inspect</b></i>
              <i style={{ left: '40%' }}><b>Watch</b></i>
            </div>
            <div className="ov-runway-labels">
              <span>Critical</span>
              <span>Inspection threshold</span>
              <span>Nominal</span>
            </div>
          </div>
        </div>

        <div className="card ov-efficiency-panel">
          <div className="ov-section-head">
            <div>
              <h2>Efficiency Impact</h2>
              <p>Energy and fuel snapshot</p>
            </div>
            <TrendingUp size={17} color="var(--tx-secondary)" />
          </div>
          <div className="ov-efficiency-content">
            <div className="ov-eff-ring" style={{ ['--eff-angle' as string]: `${Math.max(0, Math.min(100, tags?.efficiency ?? 0)) * 3.6}deg` }}>
              <div>
                <strong>{tags ? tags.efficiency.toFixed(1) : '--'}</strong>
                <span>%</span>
              </div>
            </div>
            <div className="ov-impact-table">
              <div><span>Heat Rate</span><strong>{tags ? tags.heat_rate.toFixed(0) : '--'}</strong></div>
              <div><span>Recoverable Eff.</span><strong>{`${efficiencyLoss.toFixed(1)}%`}</strong></div>
              <div><span>Fuel Loss Est.</span><strong>{`${estimatedFuelLoss.toFixed(1)} m3/hr`}</strong></div>
              <div><span>Steam/Fuel</span><strong>{derived ? `${derived.steamToFuel.toFixed(2)} kg/m3` : '--'}</strong></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
