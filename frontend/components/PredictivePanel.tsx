'use client';

import { useEffect, useState } from 'react';
import { useNexusStore } from '@/lib/store';
import { calcRisk, getRiskConfig, getCombustionAdvice, formatEta, calcDerivedMetrics } from '@/lib/utils';
import { GaugeChart } from './charts/GaugeChart';
import { O2Chart } from './charts/O2Chart';
import { PerformanceTrends } from './charts/PerformanceTrends';
import { ThermalCoupling } from './charts/ThermalCoupling';
import { DegradationScatter } from './charts/DegradationScatter';
import { AnomalyChart } from './charts/AnomalyChart';
import { ForecastChart } from './charts/ForecastChart';
import { ShadowSetpointChart } from './charts/ShadowSetpointChart';
import { PredictiveRunwayGauge } from './charts/PredictiveRunwayGauge';
import { BeforeAfterReplayChart } from './charts/BeforeAfterReplayChart';
import { AutopilotConsole } from './AutopilotConsole';

const MAX_CHART_POINTS = 60;

function computeInterventionRelIdx(heartbeatCount: number, event: { heartbeatCountAtDetection: number; arrLengthAtDetection: number } | undefined): number | null {
  if (!event) return null;
  const totalAdded = heartbeatCount - event.heartbeatCountAtDetection;
  const overflow = Math.max(0, totalAdded - (MAX_CHART_POINTS - event.arrLengthAtDetection));
  const relIdx = event.arrLengthAtDetection - 1 - overflow;
  return relIdx;
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

  // Level gauge color
  const lvlColor = !tags ? '#10b981'
    : tags.drum_level < 200 ? '#ef4444'
    : tags.drum_level < 280 ? '#f59e0b'
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

  const forecastEtaClass = isBreached ? 'text-2xl font-bold digit text-red-500 animate-pulse'
    : isTrendingDown && countdown !== '' ? (
      parseEtaSecs(countdown) < 90 ? 'text-2xl font-bold digit text-red-500 animate-pulse'
      : parseEtaSecs(countdown) < 600 ? 'text-2xl font-bold digit text-orange-400'
      : 'text-2xl font-bold digit text-amber-400'
    )
    : 'text-2xl font-bold digit text-emerald-400';

  const forecastRateText = isBreached ? '' : isTrendingDown ? `${(healthSlope * 60).toFixed(2)} %/min` : (healthSlope > 0.004 ? 'recovering' : 'stable');
  const forecastRateColor = isTrendingDown ? '#f87171' : '#4ade80';

  const forecastDetail = isBreached
    ? `Tube health ${tags?.tube_health.toFixed(1)}% is below the 70% inspection threshold — schedule inspection now.`
    : isTrendingDown
    ? `At this rate, tube health hits the 70% threshold in ${countdown || '...'}.`
    : 'Tube health stable — no threshold breach projected.';

  // Compute intervention relative index for charts
  const lastIntervention = interventionEvents[interventionEvents.length - 1];
  const interventionRelIdx = computeInterventionRelIdx(heartbeatCount, lastIntervention);
  const interventionLabel = lastIntervention?.label ?? null;

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

      <div className="card-content">
        {/* Risk Bar */}
        <div className="mb-6">
          <div className="flex justify-between text-[11px] mb-2" style={{ color: 'var(--tx-label)' }}>
            <span>Boiler #1 — Overall Health</span>
            <span className={riskCfg.textClass + ' font-medium'}>{riskCfg.label}</span>
          </div>
          <div id="risk-bar-track" className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-elevated)' }}>
            <div
              className={`risk-bar h-full rounded-full ${riskCfg.barClass}`}
              style={{ width: `${risk}%` }}
            />
          </div>
        </div>

        {/* Forecast + Advisor + Runway */}
        <div className="grid grid-cols-3 gap-3 mb-4">
          {/* Degradation Forecaster */}
          <div className="inner-card" id="forecast-card">
            <div className="flex justify-between items-center mb-1.5">
              <span className="text-[10px] font-semibold tracking-wider uppercase" style={{ color: 'var(--tx-label)' }}>
                Degradation Forecast
              </span>
              <span className="text-[10px] digit font-semibold" style={{ color: forecastRateColor }}>
                {forecastRateText}
              </span>
            </div>
            <div className={forecastEtaClass}>{forecastEtaText}</div>
            <div className="text-[10.5px] mt-1 leading-snug" style={{ color: 'var(--tx-secondary)' }}>
              {forecastDetail}
            </div>
          </div>

          {/* Combustion Advisor */}
          <div className="inner-card" id="advisor-card">
            <div className="flex justify-between items-center mb-1.5">
              <span className="text-[10px] font-semibold tracking-wider uppercase" style={{ color: 'var(--tx-label)' }}>
                Combustion Advisor
              </span>
              {advice && (
                <span className={`text-[9px] font-bold px-2 py-0.5 rounded ${advice.badgeClass}`}>
                  {advice.badge}
                </span>
              )}
            </div>
            <div
              className="text-[11.5px] leading-relaxed"
              style={{ color: 'var(--tx-label)' }}
              dangerouslySetInnerHTML={{ __html: advice?.html ?? 'Waiting for telemetry…' }}
            />
          </div>

          {/* Predictive Runway Gauge */}
          <PredictiveRunwayGauge
            forecastDeadline={forecastDeadline}
            interventionEvents={interventionEvents}
          />
        </div>

        {/* Closed-loop autopilot console — real AI control commands */}
        <div className="mb-4">
          <AutopilotConsole />
        </div>

        {/* Charts */}
        <div className="space-y-4">
          {/* Row 1: Gauges */}
          <div className="grid grid-cols-4 gap-3">
            <GaugeChart
              value={tags?.steam_pressure ?? 0}
              maxValue={16}
              color={pressColor}
              label="STEAM PRESSURE"
              unit="bar"
            />
            <GaugeChart
              value={tags?.drum_level ?? 0}
              maxValue={600}
              color={lvlColor}
              label="DRUM LEVEL"
              unit="mm"
            />
            <GaugeChart
              value={tags?.efficiency ?? 0}
              maxValue={100}
              color={effColor}
              label="EFFICIENCY"
              unit="%"
            />
            <GaugeChart
              value={derived?.boilerLoad ?? 0}
              maxValue={120}
              color={loadColor}
              label="BOILER LOAD"
              unit="%"
            />
          </div>
          {/* Row 1b: O2 + derived KPI strip */}
          <div className="grid grid-cols-3 gap-3">
            <O2Chart value={tags?.o2_percent ?? 0} />
            {/* Pressure Margin mini-card */}
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
              <div className="text-[10px]" style={{ color: 'var(--tx-muted)' }}>bar to SV lift</div>
            </div>
            {/* Steam/Fuel ratio mini-card */}
            <div className="inner-card flex flex-col justify-center items-center gap-1">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-center" style={{ color: 'var(--tx-label)' }}>
                Steam / Fuel
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
              <div className="text-[10px]" style={{ color: 'var(--tx-muted)' }}>kg steam / m³ fuel</div>
            </div>
          </div>

          {/* Row 2: Trends + Divergence — now with intervention lines */}
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

          {/* Row 2b: Shadow Setpoint + Before/After Replay */}
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

          {/* Row 3: Moirai Forecast Charts */}
          <div className="grid grid-cols-2 gap-3">
            <ForecastChart
              metric={moiraiForecast?.metrics?.tube_health}
              label="Tube Health %"
              color="#3b82f6"
              breachLine={70}
              isLight={isLight}
              backend={moiraiForecast?.backend}
            />
            <ForecastChart
              metric={moiraiForecast?.metrics?.efficiency}
              label="Efficiency %"
              color="#10b981"
              isLight={isLight}
              backend={moiraiForecast?.backend}
            />
          </div>

          {/* Row 4: Scatter + Anomaly */}
          <div className="grid grid-cols-2 gap-3">
            <DegradationScatter data={scatterData} isLight={isLight} />
            <AnomalyChart
              labels={anomalySeries.labels}
              data={anomalySeries.datasets[0]}
              score={anomalyScore}
              isLight={isLight}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function parseEtaSecs(eta: string): number {
  if (eta.includes('days')) return parseFloat(eta) * 86400;
  if (eta.includes('h')) {
    const [h, m] = eta.replace('~', '').split('h');
    return parseInt(h) * 3600 + parseInt(m || '0') * 60;
  }
  if (eta.includes('m')) {
    const [m, s] = eta.replace('~', '').split('m');
    return parseInt(m) * 60 + parseInt(s || '0');
  }
  return parseInt(eta.replace(/\D/g, '')) || 9999;
}
