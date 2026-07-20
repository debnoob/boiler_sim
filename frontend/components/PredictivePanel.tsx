'use client';

import { useEffect, useState } from 'react';
import { useNexusStore } from '@/lib/store';
import { calcRisk, getRiskConfig, getCombustionAdvice, formatEta, calcDerivedMetrics } from '@/lib/utils';
import { GaugeChart } from './charts/GaugeChart';
import { DrumLevelGauge } from './charts/DrumLevelGauge';
import { O2Chart } from './charts/O2Chart';
import { PerformanceTrends } from './charts/PerformanceTrends';
import { ThermalCoupling } from './charts/ThermalCoupling';
import { DegradationScatter } from './charts/DegradationScatter';
import { AnomalyChart } from './charts/AnomalyChart';
import { ForecastChart } from './charts/ForecastChart';
import { ShadowSetpointChart } from './charts/ShadowSetpointChart';
import { PredictiveRunwayGauge } from './charts/PredictiveRunwayGauge';
import { BeforeAfterReplayChart } from './charts/BeforeAfterReplayChart';
import { GhostLineChart } from './charts/GhostLineChart';
import { AutopilotConsole } from './AutopilotConsole';

const MAX_CHART_POINTS = 60;

function computeInterventionRelIdx(heartbeatCount: number, event: { heartbeatCountAtDetection: number; arrLengthAtDetection: number } | undefined): number | null {
  if (!event) return null;
  const totalAdded = heartbeatCount - event.heartbeatCountAtDetection;
  const overflow = Math.max(0, totalAdded - (MAX_CHART_POINTS - event.arrLengthAtDetection));
  const relIdx = event.arrLengthAtDetection - 1 - overflow;
  return relIdx;
}

function latestDelta(series: number[]): number | null {
  if (series.length < 2) return null;
  return series[series.length - 1] - series[Math.max(0, series.length - 10)];
}

const iconPaths: Record<string, string> = {
  risk: 'M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z',
  bars: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  clock: 'M12 8v4l3 2M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
  gauge: 'M3 3v18h18M7 14l3-3 3 3 5-6',
  diag: 'M22 12h-4l-3 9L9 3l-3 9H2',
  action: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  flame: 'M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z',
};

function HdrIcon({ name, className }: { name: string; className?: string }) {
  return (
    <svg className={className ?? 'w-3 h-3 shrink-0'} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={iconPaths[name]} />
    </svg>
  );
}

function DeltaArrow({ up }: { up: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {up ? <path d="M7 17 17 7M9 7h8v8" /> : <path d="M7 7l10 10M17 9v8H9" />}
    </svg>
  );
}

function Sparkline({ data, color }: { data: number[]; color: string }) {
  const points = data.slice(-24);
  if (points.length < 2) {
    return <div className="h-7 w-20 rounded-sm" style={{ background: 'var(--bg-base)', border: '1px solid var(--bd-inner)' }} />;
  }

  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const d = points.map((p, i) => {
    const x = (i / (points.length - 1)) * 84;
    const y = 28 - ((p - min) / range) * 24 - 2;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  return (
    <svg viewBox="0 0 84 30" className="h-7 w-20" aria-hidden="true">
      <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d={`${d} L84,30 L0,30 Z`} fill={color} opacity="0.12" />
    </svg>
  );
}

function DriverBar({ label, value, color }: { label: string; value: number; color: string }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="grid grid-cols-[minmax(110px,1fr)_2fr_38px] items-center gap-3">
      <span className="truncate text-[11px] font-semibold" style={{ color: 'var(--tx-label)' }}>{label}</span>
      <div className="h-1.5 rounded-full" style={{ background: 'var(--bg-base)' }}>
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color, boxShadow: `0 0 12px ${color}55` }} />
      </div>
      <span className="digit text-right text-[11px] font-bold" style={{ color }}>{pct.toFixed(0)}%</span>
    </div>
  );
}

function KpiTile({
  label,
  value,
  detail,
  tone,
  spark,
  delta,
  deltaGoodWhen,
  deltaSuffix,
}: {
  label: string;
  value: string;
  detail: string;
  tone: string;
  spark?: number[];
  delta?: number | null;
  deltaGoodWhen?: 'up' | 'down';
  deltaSuffix?: string;
}) {
  const hasDelta = delta != null && Number.isFinite(delta);
  const up = hasDelta && (delta as number) >= 0;
  const good = deltaGoodWhen ? (up ? deltaGoodWhen === 'up' : deltaGoodWhen === 'down') : true;
  const deltaColor = !hasDelta || !deltaGoodWhen ? 'var(--tx-secondary)' : good ? '#22c55e' : '#ef4444';
  return (
    <div className="predictive-kpi">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--tx-muted)' }}>{label}</div>
          <div className="digit mt-2 text-2xl font-black leading-none" style={{ color: tone }}>{value}</div>
        </div>
        {spark && <Sparkline data={spark} color={tone} />}
      </div>
      {hasDelta ? (
        <div className="mt-2 flex items-center gap-1.5 text-[10px] font-semibold">
          <span className="digit inline-flex items-center gap-0.5 font-bold" style={{ color: deltaColor }}>
            <DeltaArrow up={up} />
            {up ? '+' : ''}{(delta as number).toFixed(2)}
          </span>
          {deltaSuffix && <span style={{ color: 'var(--tx-muted)' }}>{deltaSuffix}</span>}
        </div>
      ) : (
        <div className="mt-2 text-[10px] font-semibold" style={{ color: 'var(--tx-secondary)' }}>{detail}</div>
      )}
    </div>
  );
}

function RecommendedAction({
  rank,
  priority,
  title,
  detail,
  impact,
  tone,
}: {
  rank: number;
  priority: string;
  title: string;
  detail: string;
  impact: string;
  tone: 'crit' | 'warn' | 'ok';
}) {
  const toneColor = `var(--status-${tone})`;
  return (
    <div className="flex gap-3 rounded-md border px-3 py-2" style={{ borderColor: toneColor, background: 'rgba(255,255,255,0.018)' }}>
      <div
        className="digit mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[12px] font-black"
        style={{ background: 'var(--bg-base)', border: `1px solid ${toneColor}`, color: toneColor }}
      >
        {rank}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className={`status-pill ${tone}`}>{priority}</span>
          <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: 'var(--tx-muted)' }}>{impact}</span>
        </div>
        <div className="mt-2 text-[12px] font-bold" style={{ color: 'var(--tx-primary)' }}>{title}</div>
        <div className="mt-1 text-[10px] leading-snug" style={{ color: 'var(--tx-secondary)' }}>{detail}</div>
      </div>
    </div>
  );
}

export function PredictivePanel() {
  const {
    tags, degradationFactor, forecastDeadline, healthHistory,
    performanceSeries, divergenceSeries, anomalySeries, scatterData,
    anomalyScore, isLight, moiraiForecast,
    fuelFlowSeries, heartbeatCount, interventionEvents,
  } = useNexusStore();

  const [countdown, setCountdown] = useState<string>('');

  useEffect(() => {
    const tick = () => {
      if (forecastDeadline == null) { setCountdown(''); return; }
      const remaining = forecastDeadline - Date.now() / 1000;
      if (remaining <= 0) { setCountdown('IMMINENT'); return; }
      setCountdown(formatEta(remaining));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [forecastDeadline]);

  const risk = tags ? calcRisk(tags, degradationFactor) : 0;
  const riskCfg = getRiskConfig(risk);
  const advice = tags ? getCombustionAdvice(tags) : null;
  const derived = tags ? calcDerivedMetrics(tags) : null;

  // Pressure gauge color
  const pressColor = !tags ? '#10b981'
    : tags.steam_pressure > 13 ? '#ef4444'
    : tags.steam_pressure > 12 ? '#f59e0b'
    : '#10b981';

  // Efficiency gauge color
  const effColor = !tags ? '#10b981'
    : tags.efficiency < 75 ? '#ef4444'
    : tags.efficiency < 82 ? '#f59e0b'
    : '#10b981';

  // Boiler load gauge color
  const loadColor = !derived ? '#10b981'
    : derived.boilerLoad > 100 ? '#ef4444'
    : derived.boilerLoad > 92 ? '#f59e0b'
    : '#10b981';

  const pressureStatus = !tags ? 'NO DATA'
    : tags.steam_pressure > 13 ? 'CRITICAL'
    : tags.steam_pressure > 12 ? 'WARNING'
    : 'NORMAL';
  const efficiencyStatus = !tags ? 'NO DATA'
    : tags.efficiency < 75 ? 'CRITICAL'
    : tags.efficiency < 82 ? 'WARNING'
    : 'NORMAL';
  const loadStatus = !derived ? 'NO DATA'
    : derived.boilerLoad > 100 ? 'CRITICAL'
    : derived.boilerLoad > 92 ? 'WARNING'
    : 'NORMAL';

  // Forecast state
  const isTrendingDown = healthHistory.length >= 10 && forecastDeadline != null;
  const isBreached = tags && tags.tube_health <= 70;
  const healthSlope = (() => {
    if (healthHistory.length < 10) return 0;
    const n = healthHistory.length;
    const t0 = healthHistory[0].t;
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (const p of healthHistory) { const x = p.t - t0; sx += x; sy += p.v; sxy += x * p.v; sxx += x * x; }
    const denom = n * sxx - sx * sx;
    return denom !== 0 ? (n * sxy - sx * sy) / denom : 0;
  })();

  const forecastEtaText = isBreached ? 'BREACHED'
    : isTrendingDown ? countdown || '...'
    : 'No trend';

  const forecastRateText = isBreached ? '' : isTrendingDown ? `${(healthSlope * 60).toFixed(2)} %/min` : (healthSlope > 0.004 ? 'recovering' : 'stable');

  const forecastDetail = isBreached
    ? `Tube health ${tags?.tube_health.toFixed(1)}% is below the 70% inspection threshold — schedule inspection now.`
    : isTrendingDown
    ? `At this rate, tube health hits the 70% threshold in ${countdown || '...'}.`
    : 'Tube health stable — no threshold breach projected.';

  // Compute intervention relative index for charts
  const lastIntervention = interventionEvents[interventionEvents.length - 1];
  const interventionRelIdx = computeInterventionRelIdx(heartbeatCount, lastIntervention);
  const interventionLabel = lastIntervention?.label ?? null;
  const backendLabel = moiraiForecast?.backend === 'uni2ts'
    ? 'Moirai 2.0'
    : moiraiForecast?.backend === 'simulation'
    ? 'Stat fallback'
    : moiraiForecast?.backend
    ? 'HF model'
    : 'Awaiting model';
  const modelConfidence = moiraiForecast?.backend === 'uni2ts' ? 91 : moiraiForecast?.backend === 'simulation' ? 63 : moiraiForecast ? 78 : 0;
  const tubeHealth = tags?.tube_health ?? 0;
  const healthDelta = latestDelta(healthHistory.map((p) => p.v));
  const efficiencyDelta = latestDelta(performanceSeries.datasets[0]);
  const anomalyDelta = latestDelta(anomalySeries.datasets[0]);
  const runwayTone = isBreached ? '#ef4444' : isTrendingDown ? '#f59e0b' : '#22c55e';
  const healthTone = !tags ? 'var(--tx-secondary)' : tubeHealth <= 70 ? '#ef4444' : tubeHealth < 82 ? '#f59e0b' : '#22c55e';
  const confidenceTone = modelConfidence >= 85 ? '#38bdf8' : modelConfidence >= 70 ? '#f59e0b' : 'var(--tx-muted)';
  const riskTone = risk >= 70 ? '#ef4444' : risk >= 38 ? '#f59e0b' : '#22c55e';
  const riskState = risk >= 70 ? 'High Risk' : risk >= 38 ? 'Elevated Risk' : 'Stable Watch';
  const failureWindow = isBreached ? 'Now' : isTrendingDown ? (countdown || 'Calculating') : 'No breach';
  const interventionImpact = lastIntervention ? `${lastIntervention.fuelFlowReduction}% fuel cut` : 'Standby';
  const pressureDriver = tags ? Math.max(0, ((tags.steam_pressure - 10) / 4) * 100) : 0;
  const heatDriver = tags ? Math.max(0, ((tags.flue_gas_temp - 210) / 90) * 100) : 0;
  const tubeDriver = tags ? Math.max(0, 100 - tags.tube_health) : 0;
  const efficiencyDriver = tags ? Math.max(0, 88 - tags.efficiency) * 4 : 0;
  const riskDrivers = [
    { label: 'Tube degradation', value: Math.max(tubeDriver, risk * 0.78), color: '#ef4444' },
    { label: 'Pressure margin', value: pressureDriver, color: '#f59e0b' },
    { label: 'Flue gas heat', value: heatDriver, color: '#38bdf8' },
    { label: 'Efficiency loss', value: efficiencyDriver, color: '#22c55e' },
  ].sort((a, b) => b.value - a.value).slice(0, 4);
  const primaryForecastMetric = moiraiForecast?.metrics?.tube_health;

  return (
    <div id="predict-card" className="card">
      <div className="card-header flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--bd-inner)', color: 'var(--tx-secondary)' }}>
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-bold" style={{ color: 'var(--tx-primary)' }}>Predictive Intelligence</h2>
            <p className="text-xs font-medium" style={{ color: 'var(--tx-secondary)' }}>IoT Sensor Fusion • Physics-Based ML</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Moirai backend badge */}
          {moiraiForecast && (
            <div
              className="text-[9px] font-bold px-2 py-0.5 rounded flex items-center gap-1"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--bd-inner)', color: moiraiForecast.backend === 'uni2ts' ? '#4ade80' : '#f59e0b' }}
            >
              <span>{moiraiForecast.backend === 'uni2ts' ? 'Moirai 2.0' : moiraiForecast.backend === 'simulation' ? 'Stat Fallback' : 'HF Model'}</span>
            </div>
          )}
          <div className="text-right">
            <div className="text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--tx-secondary)' }}>Failure Risk</div>
            <div className="text-3xl font-bold digit val-highlight">{risk}%</div>
          </div>
        </div>
      </div>

      <div className="card-content space-y-4">
        <section className="predictive-status-band">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--tx-muted)' }}><HdrIcon name="risk" />Overall Risk</div>
            <div className="mt-3 flex items-end gap-3">
              <div className="digit text-4xl font-black leading-none" style={{ color: riskTone }}>{riskState}</div>
              <div className="digit pb-1 text-2xl font-black" style={{ color: riskTone }}>{risk}%</div>
            </div>
            <p className="mt-3 max-w-xl text-[12px] leading-relaxed" style={{ color: 'var(--tx-secondary)' }}>{forecastDetail}</p>
          </div>

          <div className="space-y-3 border-l pl-5" style={{ borderColor: 'var(--bd-inner)' }}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--tx-muted)' }}><HdrIcon name="bars" />Risk Driver Breakdown</div>
              <span className={`status-pill ${risk >= 70 ? 'crit' : risk >= 38 ? 'warn' : 'ok'}`}>{riskCfg.label}</span>
            </div>
            {riskDrivers.map((driver) => (
              <DriverBar key={driver.label} {...driver} />
            ))}
          </div>

          <div className="border-l pl-5" style={{ borderColor: 'var(--bd-inner)' }}>
            <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--tx-muted)' }}><HdrIcon name="clock" />Predicted Failure Window</div>
            <div className="digit mt-3 text-4xl font-black leading-none" style={{ color: runwayTone }}>{failureWindow}</div>
            <div className="mt-3 text-[12px] leading-relaxed" style={{ color: 'var(--tx-secondary)' }}>
              {isTrendingDown ? 'Projected tube-health threshold crossing at current slope.' : 'No threshold breach projected from the current trend.'}
            </div>
            <div className="mt-4 h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-base)' }}>
              <div className="risk-bar h-full rounded-full" style={{ width: `${risk}%`, background: riskTone }} />
            </div>
          </div>
        </section>

        <section className="predictive-kpi-grid">
          <KpiTile
            label="Tube Health"
            value={tags ? `${tubeHealth.toFixed(1)}%` : '--'}
            detail="Collecting trend"
            delta={healthDelta}
            deltaGoodWhen="up"
            deltaSuffix="pts / 10 samples"
            tone={healthTone}
            spark={healthHistory.map((p) => p.v)}
          />
          <KpiTile
            label="Remaining Runway"
            value={forecastEtaText}
            detail={forecastRateText || 'Stable'}
            tone={runwayTone}
            spark={healthHistory.map((p) => p.v)}
          />
          <KpiTile
            label="Model Confidence"
            value={modelConfidence ? `${modelConfidence}%` : '--'}
            detail={backendLabel}
            tone={confidenceTone}
            spark={primaryForecastMetric?.p50}
          />
          <KpiTile
            label="Efficiency"
            value={tags ? `${tags.efficiency.toFixed(1)}%` : '--'}
            detail="Awaiting samples"
            delta={efficiencyDelta}
            deltaGoodWhen="up"
            deltaSuffix="pts / 10 samples"
            tone={effColor}
            spark={performanceSeries.datasets[0]}
          />
          <KpiTile
            label="Anomaly Score"
            value={`${anomalyScore.toFixed(1)}%`}
            detail="Detector warming"
            delta={anomalyDelta}
            deltaGoodWhen="down"
            deltaSuffix="pts / 10 samples"
            tone={anomalyScore > 70 ? '#ef4444' : anomalyScore > 30 ? '#f59e0b' : '#22c55e'}
            spark={anomalySeries.datasets[0]}
          />
        </section>

        <section className="predictive-primary-grid">
          <div className="space-y-4">
            <ForecastChart
              metric={primaryForecastMetric}
              label="Tube Health %"
              color="#38bdf8"
              breachLine={70}
              isLight={isLight}
              backend={moiraiForecast?.backend}
              size="hero"
              subtitle="Actual history, median forecast, confidence band, and inspection threshold"
            />
            <GhostLineChart
              healthHistory={healthHistory}
              interventionEvents={interventionEvents}
              forecastDeadline={forecastDeadline}
              heartbeatCount={heartbeatCount}
              isLight={isLight}
            />
          </div>

          <aside className="space-y-3">
            <PredictiveRunwayGauge
              forecastDeadline={forecastDeadline}
              interventionEvents={interventionEvents}
            />
            <div className="inner-card">
              <div className="chart-card-header">
                <div className="chart-card-title flex items-center gap-1.5"><HdrIcon name="action" />Recommended Actions</div>
                <span className="status-pill ai">AI ranked</span>
              </div>
              <div className="space-y-2">
                <RecommendedAction
                  rank={1}
                  priority={risk >= 70 ? 'High' : risk >= 38 ? 'Medium' : 'Watch'}
                  title={tubeHealth <= 76 ? 'Inspect tube health trend' : 'Validate forecast slope'}
                  detail={tubeHealth <= 76 ? 'Prioritize tube inspection before the 70% threshold is reached.' : 'Keep monitoring the forecast band and health slope.'}
                  impact="Reliability"
                  tone={risk >= 70 ? 'crit' : risk >= 38 ? 'warn' : 'ok'}
                />
                <RecommendedAction
                  rank={2}
                  priority={advice?.badge ?? 'Combustion'}
                  title="Tune combustion window"
                  detail="Use O2 and flue-gas temperature movement to avoid efficiency loss."
                  impact="Efficiency"
                  tone={tags && tags.efficiency < 82 ? 'warn' : 'ok'}
                />
                <RecommendedAction
                  rank={3}
                  priority={lastIntervention ? 'Active' : 'Standby'}
                  title="Autopilot intervention impact"
                  detail={lastIntervention ? `Latest action: ${interventionImpact}. Review setpoint impact below.` : 'No intervention required while plant remains inside nominal limits.'}
                  impact="Control"
                  tone={lastIntervention ? 'ok' : 'warn'}
                />
              </div>
            </div>
            <div className="inner-card" id="advisor-card">
              <div className="chart-card-header">
                <div className="chart-card-title flex items-center gap-1.5"><HdrIcon name="flame" />Combustion Advisor</div>
                {advice && <span className={`text-[9px] font-bold px-2 py-0.5 rounded ${advice.badgeClass}`}>{advice.badge}</span>}
              </div>
              <div
                className="text-[11.5px] leading-relaxed"
                style={{ color: 'var(--tx-label)' }}
                dangerouslySetInnerHTML={{ __html: advice?.html ?? 'Waiting for telemetry...' }}
              />
            </div>
          </aside>
        </section>

        <section>
          <AutopilotConsole />
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="flex items-center gap-1.5 text-sm font-bold" style={{ color: 'var(--tx-primary)' }}><HdrIcon name="gauge" className="w-3.5 h-3.5 shrink-0" />Live Operating Context</h3>
              <p className="text-[11px]" style={{ color: 'var(--tx-secondary)' }}>Gauge readings, limits, and supporting diagnostics</p>
            </div>
            <span className="status-pill info">Live 60s</span>
          </div>

          <div className="grid grid-cols-4 gap-3">
            <GaugeChart
              value={tags?.steam_pressure ?? 0}
              maxValue={16}
              color={pressColor}
              label="STEAM PRESSURE"
              unit="bar"
              setpoint={10}
              statusLabel={pressureStatus}
              reference="SP 10 · Warn >12 · Crit >13 bar"
              zones={[
                { from: 0, to: 12, color: 'rgba(16,185,129,0.55)', label: 'Normal' },
                { from: 12, to: 13, color: 'rgba(245,158,11,0.65)', label: 'Warning' },
                { from: 13, to: 16, color: 'rgba(239,68,68,0.6)', label: 'Critical' },
              ]}
            />
            <DrumLevelGauge value={tags?.drum_level ?? 0} />
            <GaugeChart
              value={tags?.efficiency ?? 0}
              maxValue={100}
              color={effColor}
              label="EFFICIENCY"
              unit="%"
              setpoint={87}
              statusLabel={efficiencyStatus}
              reference="Target 87 · Warn <82 · Crit <75%"
              zones={[
                { from: 0, to: 75, color: 'rgba(239,68,68,0.6)', label: 'Critical' },
                { from: 75, to: 82, color: 'rgba(245,158,11,0.65)', label: 'Warning' },
                { from: 82, to: 100, color: 'rgba(16,185,129,0.55)', label: 'Normal' },
              ]}
            />
            <GaugeChart
              value={derived?.boilerLoad ?? 0}
              maxValue={120}
              color={loadColor}
              label="BOILER LOAD"
              unit="%"
              setpoint={88}
              statusLabel={loadStatus}
              reference="Rated 2600 kg/hr · Warn >92 · Crit >100%"
              zones={[
                { from: 0, to: 92, color: 'rgba(16,185,129,0.55)', label: 'Normal' },
                { from: 92, to: 100, color: 'rgba(245,158,11,0.65)', label: 'Warning' },
                { from: 100, to: 120, color: 'rgba(239,68,68,0.6)', label: 'Critical' },
              ]}
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <O2Chart value={tags?.o2_percent ?? 0} />
            <div className="inner-card flex flex-col justify-center items-center gap-1">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-center" style={{ color: 'var(--tx-label)' }}>
                Pressure Margin
              </div>
              <div
                className="text-2xl font-bold digit"
                style={{
                  color: !derived ? 'var(--tx-value)'
                    : derived.pressureMargin < 0.5 ? '#ef4444'
                    : derived.pressureMargin < 1.5 ? '#fbbf24'
                    : '#4ade80',
                }}
              >
                {derived ? `${derived.pressureMargin.toFixed(2)}` : '--'}
              </div>
              {/* Range meter: full margin (~3.5 bar, 10 -> 13.5 SV lift) down to 0 */}
              <div style={{ width: '78%', height: 4, borderRadius: 2, background: 'var(--bd-inner)', overflow: 'hidden' }}>
                <div style={{
                  height: '100%', borderRadius: 2,
                  width: `${Math.max(0, Math.min(100, (derived ? derived.pressureMargin / 3.5 * 100 : 0)))}%`,
                  background: !derived ? 'var(--tx-muted)'
                    : derived.pressureMargin < 0.5 ? '#ef4444'
                    : derived.pressureMargin < 1.5 ? '#fbbf24'
                    : '#4ade80',
                }} />
              </div>
              <div className="text-[10px]" style={{ color: 'var(--tx-muted)' }}>bar to SV lift</div>
            </div>
            <div className="inner-card flex flex-col justify-center items-center gap-1">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-center" style={{ color: 'var(--tx-label)' }}>
                Steam-to-Fuel Ratio
              </div>
              <div
                className="text-2xl font-bold digit"
                style={{
                  color: !derived ? 'var(--tx-value)'
                    : derived.steamToFuel < 14 ? '#fbbf24'
                    : '#4ade80',
                }}
              >
                {derived ? derived.steamToFuel.toFixed(1) : '--'}
              </div>
              {/* Range meter across a typical 10–18 kg steam / m³ fuel band */}
              <div style={{ width: '78%', height: 4, borderRadius: 2, background: 'var(--bd-inner)', overflow: 'hidden' }}>
                <div style={{
                  height: '100%', borderRadius: 2,
                  width: `${Math.max(0, Math.min(100, (derived ? (derived.steamToFuel - 10) / 8 * 100 : 0)))}%`,
                  background: !derived ? 'var(--tx-muted)'
                    : derived.steamToFuel < 14 ? '#fbbf24'
                    : '#4ade80',
                }} />
              </div>
              <div className="text-[10px]" style={{ color: 'var(--tx-muted)' }}>kg steam / m³ fuel</div>
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <div>
            <h3 className="flex items-center gap-1.5 text-sm font-bold" style={{ color: 'var(--tx-primary)' }}><HdrIcon name="diag" className="w-3.5 h-3.5 shrink-0" />Supporting Diagnostics</h3>
            <p className="text-[11px]" style={{ color: 'var(--tx-secondary)' }}>Thermal coupling, control deltas, forecasts, and anomaly correlation</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <PerformanceTrends
              labels={performanceSeries.labels}
              efficiency={performanceSeries.datasets[0]}
              tubeHealth={performanceSeries.datasets[1]}
              heatRate={performanceSeries.datasets[2]}
              isLight={isLight}
              interventionRelIdx={interventionRelIdx}
            />
            <ThermalCoupling
              labels={divergenceSeries.labels}
              steamTemp={divergenceSeries.datasets[0]}
              flueGasTemp={divergenceSeries.datasets[1]}
              isLight={isLight}
              interventionRelIdx={interventionRelIdx}
              interventionLabel={interventionLabel}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <ShadowSetpointChart
              fuelFlow={fuelFlowSeries.datasets[0]}
              interventionRelIdx={interventionRelIdx}
              fuelFlowBefore={lastIntervention?.fuelFlowBefore}
              isLight={isLight}
            />
            <BeforeAfterReplayChart
              efficiency={performanceSeries.datasets[0]}
              flueGasTemp={divergenceSeries.datasets[1]}
              interventionRelIdx={interventionRelIdx}
              interventionTimestamp={lastIntervention?.timestamp}
              isLight={isLight}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <ForecastChart
              metric={moiraiForecast?.metrics?.efficiency}
              label="Efficiency %"
              color="#10b981"
              isLight={isLight}
              backend={moiraiForecast?.backend}
            />
            <ForecastChart
              metric={moiraiForecast?.metrics?.steam_pressure}
              label="Steam Pressure"
              color="#f59e0b"
              breachLine={13}
              isLight={isLight}
              backend={moiraiForecast?.backend}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <DegradationScatter data={scatterData} isLight={isLight} />
            <AnomalyChart
              labels={anomalySeries.labels}
              data={anomalySeries.datasets[0]}
              score={anomalyScore}
              isLight={isLight}
            />
          </div>
        </section>
      </div>
    </div>
  );
}
