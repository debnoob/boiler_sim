'use client';

import { useMemo } from 'react';
import { useNexusStore } from '@/lib/store';
import { calcRisk, calcDerivedMetrics, formatEta } from '@/lib/utils';

const TONE: Record<string, string> = { good: '#22c55e', warn: '#fbbf24', bad: '#ef4444' };
const STAT: Record<string, string> = { ok: '#22c55e', warn: '#fbbf24', crit: '#ef4444', neutral: 'var(--tx-value)' };

export default function OverviewPage() {
  const {
    tags, degradationFactor, mode, mqttStatus, anomalyScore, anomalyIsAnomaly,
    aiStatus, forecastDeadline, healthHistory, moiraiForecast,
  } = useNexusStore();

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

  const kpiCards = [
    { label: 'Steam Pressure', value: tags ? tags.steam_pressure.toFixed(1) : '--', unit: 'bar',
      status: !tags ? 'neutral' : tags.steam_pressure > 13 ? 'crit' : tags.steam_pressure > 12 ? 'warn' : 'ok' },
    { label: 'Drum Level', value: tags ? tags.drum_level.toFixed(0) : '--', unit: 'mm',
      status: !tags ? 'neutral' : tags.drum_level < 200 ? 'crit' : tags.drum_level < 280 ? 'warn' : 'ok' },
    { label: 'Efficiency', value: tags ? tags.efficiency.toFixed(1) : '--', unit: '%',
      status: !tags ? 'neutral' : tags.efficiency < 75 ? 'crit' : tags.efficiency < 82 ? 'warn' : 'ok' },
    { label: 'Tube Health', value: tags ? tags.tube_health.toFixed(1) : '--', unit: '%',
      status: !tags ? 'neutral' : tags.tube_health < 70 ? 'crit' : tags.tube_health < 80 ? 'warn' : 'ok' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1280 }}>

      {/* Status strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
        {statusCards.map(c => (
          <div key={c.label} style={{
            background: 'var(--bg-surface)', border: '1px solid var(--bd-card)',
            borderRadius: 10, padding: '14px 16px',
            display: 'flex', flexDirection: 'column', gap: 6, position: 'relative', overflow: 'hidden',
          }}>
            <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--tx-muted)' }}>
              {c.label}
            </span>
            <strong style={{ fontSize: 18, fontWeight: 800, color: TONE[c.tone], fontVariantNumeric: 'tabular-nums' }}>
              {c.value}
            </strong>
            <span style={{ position: 'absolute', top: 14, right: 14, width: 8, height: 8, borderRadius: '50%', background: TONE[c.tone], opacity: 0.85 }} />
          </div>
        ))}
      </div>

      {/* Live KPI cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
        {kpiCards.map(c => (
          <div key={c.label} className="card" style={{ padding: '20px 18px' }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--tx-muted)', marginBottom: 8 }}>
              {c.label}
            </div>
            <div style={{ fontSize: 30, fontWeight: 900, letterSpacing: '-0.03em', color: STAT[c.status], fontVariantNumeric: 'tabular-nums', display: 'flex', alignItems: 'baseline', gap: 4 }}>
              {c.value}
              {c.value !== '--' && (
                <span style={{ fontSize: 13, fontWeight: 600, opacity: 0.65 }}>{c.unit}</span>
              )}
            </div>
          </div>
        ))}
      </div>

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
