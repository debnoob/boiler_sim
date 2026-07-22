'use client';

import { CheckCircle2, ClipboardList, GitBranch, ShieldCheck, Siren, TimerReset, Wrench } from 'lucide-react';
import { useNexusStore } from '@/lib/store';
import { usePublish } from '@/lib/publishContext';
import { normalizeToString } from '@/lib/utils';
import { AlertTimeline } from '@/components/AlertTimeline';
import { Sparkline } from '@/components/charts/Sparkline';
import type { ChatMessage, DeviatedSensor, DiagnosisPayload } from '@/types/telemetry';

type SeverityTone = 'critical' | 'high' | 'warning' | 'low';
type TrendSnapshot = {
  kpiSeries: { datasets: number[][] };
  fuelFlowSeries: { datasets: number[][] };
  divergenceSeries: { datasets: number[][] };
  fluePathSeries: { datasets: number[][] };
  tags: { o2_percent?: number } | null;
};

const SEVERITY_META: Record<SeverityTone, { color: string; bg: string; border: string; label: string }> = {
  critical: { color: '#ef4444', bg: 'rgba(239,68,68,0.12)', border: 'rgba(239,68,68,0.28)', label: 'Critical' },
  high: { color: '#f97316', bg: 'rgba(249,115,22,0.12)', border: 'rgba(249,115,22,0.28)', label: 'High' },
  warning: { color: '#f59e0b', bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.28)', label: 'Warning' },
  low: { color: '#22c55e', bg: 'rgba(34,197,94,0.12)', border: 'rgba(34,197,94,0.28)', label: 'Low' },
};

const AI_QUESTION_TOPIC = 'factory/pumphouse4/boiler/unit01/ai/question';

function getLatestDiagnosis(messages: ChatMessage[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === 'diagnosis' && msg.data) {
      return { data: msg.data as DiagnosisPayload, ts: msg.timestamp };
    }
  }
  return null;
}

function getSeverityTone(severity?: string): SeverityTone {
  const s = severity?.toLowerCase();
  if (s === 'critical') return 'critical';
  if (s === 'high') return 'high';
  if (s === 'low' || s === 'normal') return 'low';
  return 'warning';
}

function formatMetricValue(value: number | string | undefined) {
  if (value == null) return '--';
  if (typeof value === 'string') return value;
  if (!Number.isFinite(value)) return '--';
  if (Math.abs(value) >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (Math.abs(value) >= 100) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function formatDelta(value: number | string | undefined, baseline: number | string | undefined) {
  if (typeof value !== 'number' || typeof baseline !== 'number' || !Number.isFinite(value) || !Number.isFinite(baseline)) {
    return baseline != null ? `Baseline ${formatMetricValue(baseline)}` : 'Baseline unavailable';
  }
  const diff = value - baseline;
  const sign = diff > 0 ? '+' : '';
  return `${sign}${formatMetricValue(diff)} vs baseline`;
}

function getElapsedLabel(timestamp?: string) {
  if (!timestamp) return '--';
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return '--';
  const diffMs = Date.now() - parsed;
  if (diffMs <= 0) return 'Just now';
  const mins = Math.floor(diffMs / 60000);
  const secs = Math.floor((diffMs % 60000) / 1000);
  if (mins >= 60) {
    const hours = Math.floor(mins / 60);
    return `${hours}h ${mins % 60}m`;
  }
  return `${mins}m ${secs}s`;
}

function sensorTrend(sensor: DeviatedSensor, store: TrendSnapshot) {
  const key = `${sensor.sensor} ${sensor.tag ?? ''}`.toLowerCase();
  if (key.includes('o2')) return store.kpiSeries.datasets[0] ? store.kpiSeries.datasets[0].map(() => 0) : [];
  return [];
}

function getTrendForSensor(sensor: DeviatedSensor, store: TrendSnapshot) {
  const key = `${sensor.sensor} ${sensor.tag ?? ''}`.toLowerCase();
  if (key.includes('furnace') || key.includes('stack') || key.includes('damper') || key.includes('draft')) {
    if (key.includes('command')) return store.fluePathSeries.datasets[2] ?? [];
    if (key.includes('actual') || key.includes('position') || key.includes('damper')) return store.fluePathSeries.datasets[3] ?? [];
    return store.fluePathSeries.datasets[0] ?? [];
  }
  if (key.includes('pressure')) return store.kpiSeries.datasets[0] ?? [];
  if (key.includes('drum')) return store.kpiSeries.datasets[1] ?? [];
  if (key.includes('efficiency')) return store.kpiSeries.datasets[2] ?? [];
  if (key.includes('tube') || key.includes('health')) return store.kpiSeries.datasets[3] ?? [];
  if (key.includes('flue') && key.includes('temp')) return store.divergenceSeries.datasets[1] ?? [];
  if (key.includes('flue') || key.includes('gas flow')) return store.fluePathSeries.datasets[1] ?? store.divergenceSeries.datasets[1] ?? [];
  if (key.includes('fuel')) return store.fuelFlowSeries.datasets[0] ?? [];
  if (key.includes('o2')) return store.tags?.o2_percent != null ? Array(12).fill(store.tags.o2_percent) : [];
  if (key.includes('steam temp')) return store.divergenceSeries.datasets[0] ?? [];
  return sensorTrend(sensor, store);
}

function getSensorStatus(sensor: DeviatedSensor) {
  const sev = getSeverityTone(sensor.severity);
  return SEVERITY_META[sev].label;
}

function buildOperatorActions(diagnosis: DiagnosisPayload | null, alertTag?: string) {
  const recommended = diagnosis?.recommended_action ? normalizeToString(diagnosis.recommended_action) : '';
  const topSensors = (diagnosis?.deviated_sensors ?? []).slice(0, 3).map((sensor) => sensor.sensor || sensor.tag || 'deviated sensor');
  const actions = [
    recommended || `Acknowledge and verify operating response on ${alertTag || 'the affected unit'}.`,
    topSensors[0] ? `Inspect ${topSensors[0]} trend against the last 60 seconds.` : 'Review the most recent telemetry trend for confirmation.',
    topSensors[1] ? `Capture a diagnostic snapshot for ${topSensors[1]} and attach it to the incident log.` : 'Capture a diagnostic snapshot and attach it to the incident log.',
    topSensors[2] ? `Prepare a work order if ${topSensors[2]} remains outside baseline after operator checks.` : 'Prepare a follow-up work order if the deviation persists.',
  ];
  return actions.filter(Boolean).slice(0, 4);
}

function buildWhatIfQuestion(
  diagnosis: DiagnosisPayload,
  mode: string,
  anomalyScore: number,
  alertTag?: string,
) {
  const cause = diagnosis.probable_cause || 'the current boiler incident';
  const severity = diagnosis.severity || 'unknown';
  const action = diagnosis.recommended_action
    ? normalizeToString(diagnosis.recommended_action)
    : 'no corrective action';
  const sensors = (diagnosis.deviated_sensors ?? [])
    .slice(0, 4)
    .map((sensor) => sensor.sensor || sensor.tag)
    .filter(Boolean)
    .join(', ');

  return [
    `What if we delay the recommended action for 30 minutes after this incident?`,
    `Incident: ${cause}.`,
    `Severity: ${severity}.`,
    `Mode: ${mode}.`,
    `Anomaly score: ${anomalyScore}.`,
    alertTag ? `Primary alarm: ${alertTag}.` : '',
    sensors ? `Deviated sensors: ${sensors}.` : '',
    `Recommended action being delayed: ${action}.`,
    `Simulate the likely consequence chain, risk level, and operator actions.`,
  ].filter(Boolean).join(' ');
}

export default function IncidentsPage() {
  const store = useNexusStore();
  const publish = usePublish();
  const {
    alerts,
    chatMessages,
    mode,
    anomalyScore,
    anomalyIsAnomaly,
    tags,
    kpiBaseline,
    aiStatus,
    acknowledgedAlertIds,
    acknowledgeAlert,
    addChatMessage,
  } = store;

  const latestDiagnosis = getLatestDiagnosis(chatMessages);
  const activeAlerts = alerts
    .filter((alert) => !acknowledgedAlertIds.includes(alert.id))
    .slice(-8)
    .reverse();
  const primaryAlert = activeAlerts[0] ?? alerts[alerts.length - 1] ?? null;
  const incidentSeverity = getSeverityTone(latestDiagnosis?.data.severity ?? primaryAlert?.severity);
  const severityMeta = SEVERITY_META[incidentSeverity];
  const evidenceSensors = (latestDiagnosis?.data.deviated_sensors ?? []).slice(0, 4);
  const operatorActions = buildOperatorActions(latestDiagnosis?.data ?? null, primaryAlert?.tag);
  const trendSnapshot: TrendSnapshot = {
    kpiSeries: store.kpiSeries,
    fuelFlowSeries: store.fuelFlowSeries,
    divergenceSeries: store.divergenceSeries,
    fluePathSeries: store.fluePathSeries,
    tags: store.tags,
  };
  const flueIncidentText = [
    mode,
    primaryAlert?.tag,
    primaryAlert?.message,
    latestDiagnosis?.data.probable_cause,
    ...(latestDiagnosis?.data.deviated_sensors ?? []).map((sensor) => `${sensor.sensor} ${sensor.tag ?? ''}`),
  ].filter(Boolean).join(' ').toLowerCase();
  const isFlueIncident = /flue|furnace|draft|damper|stack|chimney/.test(flueIncidentText);
  const damperMismatch = tags?.stack_damper_command_pct != null && tags?.stack_damper_actual_pct != null
    ? Math.abs(tags.stack_damper_command_pct - tags.stack_damper_actual_pct)
    : null;
  const flueEvidence = isFlueIncident && tags ? [
    {
      label: 'Furnace pressure',
      value: `${tags.furnace_pressure_pa?.toFixed(1) ?? '--'} Pa`,
      detail: `Control target ${(store.controlState?.furnace_draft_setpoint_pa ?? -20).toFixed(0)} Pa`,
      trend: store.fluePathSeries.datasets[0] ?? [],
    },
    {
      label: 'Flue gas flow',
      value: tags.flue_gas_flow_kg_hr == null ? '--' : `${Math.round(tags.flue_gas_flow_kg_hr).toLocaleString()} kg/hr`,
      detail: 'Compare against pressure response',
      trend: store.fluePathSeries.datasets[1] ?? [],
    },
    {
      label: 'Damper command / actual',
      value: tags.stack_damper_command_pct == null || tags.stack_damper_actual_pct == null
        ? '--'
        : `${tags.stack_damper_command_pct.toFixed(0)}% / ${tags.stack_damper_actual_pct.toFixed(0)}%`,
      detail: damperMismatch == null ? 'Position telemetry unavailable' : `${damperMismatch.toFixed(1)} point mismatch`,
      trend: store.fluePathSeries.datasets[3] ?? [],
    },
  ] : [];
  const runWhatIf = () => {
    if (!latestDiagnosis) return;

    const question = buildWhatIfQuestion(latestDiagnosis.data, mode, anomalyScore, primaryAlert?.tag);
    const now = Date.now();
    addChatMessage({
      id: `user-whatif-${now}`,
      type: 'user',
      content: question,
      timestamp: new Date().toLocaleTimeString(),
    });
    publish(AI_QUESTION_TOPIC, {
      type: 'what_if',
      question,
      timestamp: new Date().toISOString(),
    });
    addChatMessage({ id: 'thinking', type: 'thinking', content: '', timestamp: '' });
  };

  return (
    <div className="incidents-page">
      <section className="card incident-status-strip">
        <div className="incident-status-header">
          <div>
            <h2>Incident workspace</h2>
            <p>Live diagnosis, evidence, and response flow for Boiler Unit 01</p>
          </div>
          <span
            className="audit-pill"
            style={latestDiagnosis
              ? { background: severityMeta.bg, color: severityMeta.color, borderColor: severityMeta.border }
              : undefined}
          >
            {latestDiagnosis ? `${severityMeta.label} event` : 'Standby'}
          </span>
        </div>

        <div className="incident-status-metrics">
          <div className="incident-status-tile incident-status-tile-emphasis">
            <span>Severity</span>
            <strong style={{ color: severityMeta.color }}>{severityMeta.label}</strong>
            <em>{anomalyIsAnomaly ? 'Detector tripped' : 'Monitoring'}</em>
          </div>
          <div className="incident-status-tile">
            <span>Status</span>
            <strong>{aiStatus === 'analyzing' ? 'AI analyzing' : latestDiagnosis ? 'Active diagnosis' : 'Monitoring'}</strong>
            <em>{latestDiagnosis ? `Updated ${latestDiagnosis.ts}` : 'Waiting for anomaly trigger'}</em>
          </div>
          <div className="incident-status-tile">
            <span>Operating mode</span>
            <strong>{mode}</strong>
            <em>{tags ? `${tags.efficiency.toFixed(1)}% efficiency` : 'No live telemetry'}</em>
          </div>
          <div className="incident-status-tile">
            <span>Anomaly score</span>
            <strong>{anomalyScore.toFixed(3)}</strong>
            <em>{anomalyIsAnomaly ? 'Above threshold' : 'Below threshold'}</em>
          </div>
          <div className="incident-status-tile">
            <span>Detected</span>
            <strong>{primaryAlert ? new Date(primaryAlert.timestamp).toLocaleTimeString() : '--'}</strong>
            <em>{primaryAlert?.tag ?? 'No active alarm'}</em>
          </div>
          <div className="incident-status-tile">
            <span>Elapsed</span>
            <strong>{primaryAlert ? getElapsedLabel(primaryAlert.timestamp) : '--'}</strong>
            <em>{activeAlerts.length} active alarm(s)</em>
          </div>
        </div>
      </section>

      <section className="incidents-workspace">
        <div className="incidents-main-col">
          <div className="card incident-hero-card" style={{ ['--incident-rail' as string]: severityMeta.color }}>
            <div className="incident-hero-rail" />
            <div className="ops-panel-header incident-hero-header">
              <div>
                <h2>AI Incident Card</h2>
                <p>Qwen3.5 analyst — deterministic detector gated</p>
              </div>
              <div className="incident-hero-chips">
                <span className="status-pill ai">{aiStatus === 'analyzing' ? 'Analyzing' : 'Diagnosis ready'}</span>
                <span className="audit-pill" style={{ background: severityMeta.bg, color: severityMeta.color, borderColor: severityMeta.border }}>
                  {severityMeta.label}
                </span>
              </div>
            </div>

            <div className="incident-hero-body">
              {latestDiagnosis ? (
                <div className="incident-hero-grid">
                  <div className="incident-diagnosis-block">
                    <div className="incident-title-row">
                      <span style={{ background: severityMeta.color }}>{latestDiagnosis.data.severity || 'warning'}</span>
                      <strong>{latestDiagnosis.data.probable_cause || 'Boiler anomaly'}</strong>
                    </div>
                    {latestDiagnosis.data.explanation && (
                      <p className="incident-lead-copy">{normalizeToString(latestDiagnosis.data.explanation)}</p>
                    )}

                    <div className="incident-summary-strip">
                      <div>
                        <span>Confidence</span>
                        <strong>
                          {latestDiagnosis.data.confidence != null
                            ? `${Math.round(latestDiagnosis.data.confidence <= 1 ? latestDiagnosis.data.confidence * 100 : latestDiagnosis.data.confidence)}%`
                            : 'Pending'}
                        </strong>
                      </div>
                      <div>
                        <span>Primary alarm</span>
                        <strong>{primaryAlert?.tag ?? 'No active tag'}</strong>
                      </div>
                      <div>
                        <span>Operating mode</span>
                        <strong>{mode}</strong>
                      </div>
                    </div>

                    {latestDiagnosis.data.recommended_action && (
                      <div className="operator-action incident-action-callout">
                        <span>Recommended action</span>
                        <p style={{ whiteSpace: 'pre-line' }}>{normalizeToString(latestDiagnosis.data.recommended_action)}</p>
                      </div>
                    )}

                    <div className="action-row incident-action-row">
                      <button>
                        <CheckCircle2 size={14} strokeWidth={2.2} />
                        <span>Acknowledge</span>
                      </button>
                      <button className="secondary">
                        <ClipboardList size={14} strokeWidth={2.2} />
                        <span>Create Work Order</span>
                      </button>
                      <button className="tertiary" onClick={runWhatIf}>
                        <GitBranch size={14} strokeWidth={2.2} />
                        <span>Run What-if</span>
                      </button>
                    </div>
                  </div>

                  <div className="incident-evidence-section">
                    <div className="incident-subhead">
                      <h3>Key evidence</h3>
                      <p>Sensor deviations against live baseline and last 60-second trend</p>
                    </div>
                    {evidenceSensors.length ? (
                      <div className="incident-evidence-grid">
                        {evidenceSensors.map((sensor, index) => {
                          const trend = getTrendForSensor(sensor, trendSnapshot);
                          return (
                            <div className="incident-evidence-tile" key={`${sensor.sensor}-${index}`}>
                              <div className="incident-evidence-head">
                                <div>
                                  <span>{sensor.sensor || sensor.tag}</span>
                                  <strong>{formatMetricValue(sensor.value)}</strong>
                                </div>
                                <em>{getSensorStatus(sensor)}</em>
                              </div>
                              <p>{formatDelta(sensor.value as number | string | undefined, sensor.baseline)}</p>
                              <div className="incident-evidence-trend">
                                <Sparkline data={trend.slice(-24)} color={severityMeta.color} height={34} />
                              </div>
                              <small>{sensor.baseline != null ? `Baseline ${formatMetricValue(sensor.baseline)}` : 'Live baseline unavailable'}</small>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="empty-incident">
                        <strong>No structured evidence attached</strong>
                        <span>The next anomaly payload should include deviated sensors and baseline deltas.</span>
                      </div>
                    )}
                    {flueEvidence.length > 0 && (
                      <div className="incident-flue-evidence">
                        <div className="incident-subhead">
                          <h3>Flue-path fault chain</h3>
                          <p>Draft, flow, and damper response from the current live evidence window</p>
                        </div>
                        <div className="incident-evidence-grid">
                          {flueEvidence.map((item) => (
                            <div className="incident-evidence-tile" key={item.label}>
                              <div className="incident-evidence-head">
                                <div>
                                  <span>{item.label}</span>
                                  <strong>{item.value}</strong>
                                </div>
                                <em>Live</em>
                              </div>
                              <p>{item.detail}</p>
                              <div className="incident-evidence-trend">
                                <Sparkline data={item.trend.slice(-24)} color={severityMeta.color} height={34} />
                              </div>
                              <small>Last 60-second telemetry window</small>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="empty-incident incident-empty-large">
                  <strong>No active AI incident</strong>
                  <span>Inject a fault to trigger anomaly detection and generate an incident card.</span>
                </div>
              )}
            </div>
          </div>

          <div className="incident-timeline-wrap">
            <AlertTimeline />
          </div>
        </div>

        <aside className="incidents-sidebar-col">
          <div className="card rail-panel incident-queue-card">
            <div className="ops-panel-header">
              <div>
                <h2>Alarm Queue</h2>
                <p>Prioritised operational events from MQTT</p>
              </div>
              <span
                className="audit-pill"
                style={activeAlerts.length > 0 ? { background: 'rgba(239,68,68,0.12)', color: '#ef4444', borderColor: '#7f1d1d' } : undefined}
              >
                {activeAlerts.length ? `${activeAlerts.length} active` : 'All clear'}
              </span>
            </div>
            <div className="incident-sidebar-body">
              {activeAlerts.length ? activeAlerts.map((alert) => (
                <div className="incident-queue-item" key={alert.id}>
                  <div className="incident-queue-main">
                    <div className="incident-queue-severity">
                      <span className={`alarm-dot ${alert.severity.toLowerCase()}`} />
                      <strong>{alert.severity}</strong>
                    </div>
                    <p>{alert.tag}</p>
                    <em>{alert.message}</em>
                  </div>
                  <div className="incident-queue-side">
                    <span>{alert.value.toFixed(1)}</span>
                    <button onClick={() => acknowledgeAlert(alert.id)} aria-label={`Acknowledge ${alert.tag}`}>
                      <ShieldCheck size={13} strokeWidth={2.1} />
                    </button>
                  </div>
                </div>
              )) : (
                <div className="rail-empty">No active alarms</div>
              )}
            </div>
          </div>

          <div className="card rail-panel incident-ops-card">
            <div className="ops-panel-header">
              <div>
                <h2>Operator Actions</h2>
                <p>Suggested next steps for immediate response</p>
              </div>
              <span className="audit-pill">Checklist</span>
            </div>
            <div className="incident-sidebar-body incident-ops-list">
              {operatorActions.map((action, index) => (
                <div className="incident-ops-item" key={`${action}-${index}`}>
                  <div className="incident-ops-icon">
                    {index === 0 ? <Siren size={14} strokeWidth={2.2} /> : index === 1 ? <Wrench size={14} strokeWidth={2.2} /> : <TimerReset size={14} strokeWidth={2.2} />}
                  </div>
                  <div>
                    <strong>Step {index + 1}</strong>
                    <p>{action}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card rail-panel incident-audit-card">
            <div className="ops-panel-header">
              <div>
                <h2>Audit &amp; Status</h2>
                <p>Current incident metadata for handoff and tracking</p>
              </div>
              <span className="audit-pill">{latestDiagnosis ? 'Live log' : 'Idle'}</span>
            </div>
            <div className="incident-audit-grid">
              <div>
                <span>Source</span>
                <strong>{latestDiagnosis ? 'AI diagnosis' : 'Anomaly detector'}</strong>
              </div>
              <div>
                <span>Last update</span>
                <strong>{latestDiagnosis?.ts ?? '--'}</strong>
              </div>
              <div>
                <span>Alert tag</span>
                <strong>{primaryAlert?.tag ?? '--'}</strong>
              </div>
              <div>
                <span>Baseline</span>
                <strong>{kpiBaseline ? `${kpiBaseline.efficiency.toFixed(1)}% eff.` : '--'}</strong>
              </div>
            </div>
          </div>
        </aside>
      </section>
    </div>
  );
}
