'use client';

import { useMemo } from 'react';
import { useNexusStore } from '@/lib/store';
import { AlertTimeline } from '@/components/AlertTimeline';
import type { ChatMessage, DiagnosisPayload } from '@/types/telemetry';

function getLatestDiagnosis(messages: ChatMessage[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === 'diagnosis' && msg.data) return { data: msg.data as DiagnosisPayload, ts: msg.timestamp };
  }
  return null;
}

function severityColor(severity = 'warning') {
  const s = severity.toLowerCase();
  if (s === 'critical') return '#ef4444';
  if (s === 'high') return '#f97316';
  if (s === 'low' || s === 'normal') return '#22c55e';
  return '#f59e0b';
}

function normalizeToString(val: unknown): string {
  if (val == null) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (Array.isArray(val)) {
    return val.map((item, i) => `${i + 1}. ${normalizeToString(item)}`).join('\n');
  }
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    const text = obj.action ?? obj.step ?? obj.description ?? obj.text ?? obj.message ?? obj.recommendation;
    if (text != null) {
      const extras: string[] = [];
      if (obj.urgency) extras.push(`Urgency: ${obj.urgency}`);
      if (obj.timing) extras.push(`Timing: ${obj.timing}`);
      return extras.length ? `${normalizeToString(text)} (${extras.join(', ')})` : normalizeToString(text);
    }
    return JSON.stringify(val);
  }
  return String(val);
}

export default function IncidentsPage() {
  const { alerts, chatMessages } = useNexusStore();
  const latestDiagnosis = useMemo(() => getLatestDiagnosis(chatMessages), [chatMessages]);
  const activeAlerts = alerts.slice(-12).reverse();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: '100%' }}>
      <AlertTimeline />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* AI Incident Card */}
        <div className="card">
          <div className="ops-panel-header">
            <div>
              <h2>AI Incident Card</h2>
              <p>Local Ollama analyst — deterministic detector gated</p>
            </div>
            <span className="audit-pill">{latestDiagnosis ? `Updated ${latestDiagnosis.ts}` : 'Standby'}</span>
          </div>
          <div style={{ padding: '0 1.5rem 1.5rem 1.5rem' }}>
            {latestDiagnosis ? (
              <div className="incident-card">
                <div className="incident-title-row">
                  <span style={{ background: severityColor(latestDiagnosis.data.severity) }}>
                    {latestDiagnosis.data.severity || 'warning'}
                  </span>
                  <strong>{latestDiagnosis.data.probable_cause || 'Boiler anomaly'}</strong>
                </div>
                {latestDiagnosis.data.explanation && <p>{normalizeToString(latestDiagnosis.data.explanation)}</p>}
                <div className="evidence-list">
                  {(latestDiagnosis.data.deviated_sensors || []).slice(0, 4).map((sensor, i) => (
                    <div key={`${sensor.sensor}-${i}`}>
                      <span>{sensor.sensor || sensor.tag}</span>
                      <strong>{sensor.value ?? '--'}</strong>
                      <em>baseline {sensor.baseline ?? '--'}</em>
                    </div>
                  ))}
                </div>
                {latestDiagnosis.data.recommended_action && (
                  <div className="operator-action">
                    <span>Recommended action</span>
                    <p style={{ whiteSpace: 'pre-line' }}>{normalizeToString(latestDiagnosis.data.recommended_action)}</p>
                  </div>
                )}
                <div className="action-row">
                  <button>Acknowledge</button>
                  <button>Create Work Order</button>
                  <button>Run What-if</button>
                </div>
              </div>
            ) : (
              <div className="empty-incident">
                <strong>No active AI incident</strong>
                <span>Inject a fault to trigger anomaly detection and generate an incident card.</span>
              </div>
            )}
          </div>
        </div>

        {/* Alarm Queue */}
        <div className="card">
          <div className="ops-panel-header">
            <div>
              <h2>Alarm Queue</h2>
              <p>Prioritised operational events from MQTT</p>
            </div>
            {activeAlerts.length > 0 && (
              <span className="audit-pill" style={{ background: 'rgba(239,68,68,0.12)', color: '#ef4444', borderColor: '#7f1d1d' }}>
                {activeAlerts.length} active
              </span>
            )}
          </div>
          <div style={{ padding: '0 1.5rem 1.5rem 1.5rem' }}>
            {activeAlerts.length ? activeAlerts.map(alert => (
              <div className="rail-alert wide" key={alert.id}>
                <span className={`alarm-dot ${alert.severity.toLowerCase()}`} />
                <div>
                  <strong>{alert.severity} — {alert.tag}</strong>
                  <p>{alert.message}</p>
                  <em>{alert.value.toFixed(1)} at {new Date(alert.timestamp).toLocaleTimeString()}</em>
                </div>
              </div>
            )) : (
              <div className="rail-empty">No active alarms</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
