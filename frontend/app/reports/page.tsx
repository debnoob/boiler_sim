'use client';

import {
  Activity,
  AlertTriangle,
  Bell,
  CheckCircle2,
  ClipboardCheck,
  Download,
  FileText,
  Flame,
  Gauge,
  RadioTower,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Wind,
  Wrench,
  Zap,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { MqttStream } from '@/components/MqttStream';
import { useNexusStore } from '@/lib/store';
import { calcRisk, calcDerivedMetrics, normalizeToString } from '@/lib/utils';
import { generateReportPdf, type ReportData, type ReportKpi } from '@/lib/generateReportPdf';
import type { AiResponsePayload, ChatMessage, DiagnosisPayload } from '@/types/telemetry';

const severityRank: Record<string, number> = {
  CRITICAL: 4,
  HIGH: 3,
  WARNING: 2,
  LOW: 1,
};

function statusTone(value: number, warnAt: number, critAt: number) {
  if (value >= critAt) return 'crit';
  if (value >= warnAt) return 'warn';
  return 'ok';
}

function modeTone(mode: string) {
  if (mode === 'FAULT' || mode === 'CRITICAL') return 'crit';
  if (mode === 'DEGRADING') return 'warn';
  return 'ok';
}

function truncate(text = '', max = 190) {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}...` : compact;
}

function formatTimeLabel(timestamp?: string) {
  return timestamp || 'Live';
}

function getShiftSummary(message?: ChatMessage) {
  if (!message) return null;
  const data = message.data as AiResponsePayload | undefined;
  return data?.summary || data?.answer || data?.response || message.content;
}

function getDiagnosisTitle(message: ChatMessage) {
  const data = message.data as DiagnosisPayload | undefined;
  return data?.probable_cause || data?.explanation || 'AI diagnosis generated';
}

export default function ReportsPage() {
  const {
    tags,
    degradationFactor,
    chatMessages,
    woCount,
    alerts,
    acknowledgedAlertIds,
    interventionEvents,
    mode,
    mqttStatus,
    msgCount,
    oeeSnapshot,
    oeeHistory,
    fluePathSeries,
  } = useNexusStore();

  const risk = tags ? calcRisk(tags, degradationFactor) : 0;
  const derived = tags ? calcDerivedMetrics(tags) : null;
  const latestShiftReport = [...chatMessages].reverse().find((m) => m.type === 'shift_report');
  const diagnosisMessages = chatMessages.filter((m) => m.type === 'diagnosis');
  const latestDiagnosis = [...diagnosisMessages].reverse()[0];
  const unacknowledgedAlerts = alerts.filter((a) => !acknowledgedAlertIds.includes(a.id));
  const highestAlert = [...alerts].sort((a, b) => (severityRank[b.severity] ?? 0) - (severityRank[a.severity] ?? 0))[0];
  const efficiencyLoss = tags ? Math.max(0, 87 - tags.efficiency) : 0;
  const estimatedFuelLoss = tags && derived ? Math.max(0, efficiencyLoss * tags.fuel_flow * 0.12) : 0;
  const shiftSummary = getShiftSummary(latestShiftReport);
  const currentShift = oeeSnapshot && !oeeSnapshot.empty ? oeeSnapshot : oeeHistory.find((s) => !s.empty);
  const anomalyCount =
    currentShift?.anomaly_events ??
    (latestShiftReport?.data as AiResponsePayload | undefined)?.anomaly_events ??
    0;
  const alertFollowUps = unacknowledgedAlerts.slice(-2).map((alert) => ({
    label: `Acknowledge ${alert.severity.toLowerCase()} alert`,
    detail: `${alert.tag}: ${alert.message}`,
    tone: alert.severity === 'CRITICAL' || alert.severity === 'HIGH' ? 'crit' : 'warn',
  }));
  const aiFollowUps = latestShiftReport?.data && 'follow_ups' in latestShiftReport.data
    ? ((latestShiftReport.data as AiResponsePayload).follow_ups || []).slice(0, 3).map((item) => ({
        label: item,
        detail: 'AI shift report follow-up',
        tone: 'ai',
      }))
    : [];
  const followUps = [...alertFollowUps, ...aiFollowUps].slice(0, 4);
  const flueAlerts = alerts.filter((alert) => /flue|furnace|draft|damper|stack|chimney/i.test(`${alert.tag} ${alert.message}`));
  const activeFlueAlerts = flueAlerts.filter((alert) => !acknowledgedAlertIds.includes(alert.id));
  const pressureWindow = fluePathSeries.datasets[0] ?? [];
  const worstFurnacePressure = pressureWindow.length ? Math.max(...pressureWindow) : null;
  const damperMismatch = tags?.stack_damper_command_pct != null && tags?.stack_damper_actual_pct != null
    ? Math.abs(tags.stack_damper_command_pct - tags.stack_damper_actual_pct)
    : null;
  const flueKpiItems: ReportKpi[] = [
    {
      label: 'Flue Alarms',
      value: String(flueAlerts.length),
      context: 'Recorded in this dashboard session',
      tone: statusTone(flueAlerts.length, 1, 3),
    },
    {
      label: 'Active Flue Alarms',
      value: String(activeFlueAlerts.length),
      context: activeFlueAlerts.length ? activeFlueAlerts[0].tag : 'No active flue-path alarm',
      tone: statusTone(activeFlueAlerts.length, 1, 2),
    },
    {
      label: 'Worst Furnace Pressure',
      value: worstFurnacePressure == null ? '--' : `${worstFurnacePressure.toFixed(1)} Pa`,
      context: 'Highest pressure in latest 60-second window',
      tone: worstFurnacePressure == null ? undefined : worstFurnacePressure > -5 ? 'crit' : worstFurnacePressure > -10 || worstFurnacePressure < -90 ? 'warn' : 'ok',
    },
    {
      label: 'Damper Mismatch',
      value: damperMismatch == null ? '--' : `${damperMismatch.toFixed(1)} pts`,
      context: tags?.stack_damper_command_pct == null || tags?.stack_damper_actual_pct == null
        ? 'Command or actual position unavailable'
        : `${tags.stack_damper_command_pct.toFixed(0)}% command / ${tags.stack_damper_actual_pct.toFixed(0)}% actual`,
      tone: damperMismatch == null ? undefined : damperMismatch > 20 ? 'crit' : damperMismatch > 10 ? 'warn' : 'ok',
    },
  ];

  const eventRows = [
    ...alerts.slice(-5).map((alert) => ({
      id: `alert-${alert.id}`,
      time: formatTimeLabel(alert.timestamp),
      label: alert.message,
      detail: alert.tag,
      tone: alert.severity === 'CRITICAL' || alert.severity === 'HIGH' ? 'crit' : alert.severity === 'WARNING' ? 'warn' : 'info',
      badge: alert.severity,
    })),
    ...diagnosisMessages.slice(-4).map((msg) => {
      const data = msg.data as DiagnosisPayload | undefined;
      return {
        id: msg.id,
        time: formatTimeLabel(msg.timestamp),
        label: truncate(getDiagnosisTitle(msg), 82),
        detail: data?.recommended_action ? truncate(normalizeToString(data.recommended_action), 96) : 'Incident card generated by AI analyst',
        tone: data?.severity?.toUpperCase() === 'CRITICAL' || data?.severity?.toUpperCase() === 'HIGH' ? 'crit' : 'ai',
        badge: 'AI',
      };
    }),
    ...interventionEvents.slice(-4).map((event, index) => ({
      id: `intervention-${event.timestamp}-${index}`,
      time: formatTimeLabel(event.timestamp),
      label: truncate(event.label, 90),
      detail: `Firing reduction ${event.fuelFlowReduction}%`,
      tone: 'info',
      badge: 'CONTROL',
    })),
  ].slice(-8).reverse();

  const reportReady = Boolean(latestShiftReport) && mqttStatus === 'connected' && unacknowledgedAlerts.length === 0;

  // Single source of truth for the summary metrics and shift-context fields —
  // both the on-screen grids and the exported PDF (buildReportData) render from
  // these, so the value and tone logic can never drift between the two outputs.
  const metaItems: Array<{ label: string; value: string; tone?: string }> = [
    { label: 'Operating Mode', value: mode, tone: modeTone(mode) },
    { label: 'MQTT', value: mqttStatus },
    { label: 'Messages', value: String(msgCount) },
    { label: 'Shift Window', value: currentShift?.shift_label || 'Current' },
  ];

  const kpiItems: ReportKpi[] = [
    { label: 'Anomalies', value: String(anomalyCount), context: 'Detected this shift', tone: statusTone(anomalyCount, 1, 4) },
    { label: 'Work Orders', value: String(woCount), context: 'Current counter' },
    {
      label: 'Open Alerts',
      value: String(unacknowledgedAlerts.length),
      context: highestAlert ? `Highest: ${highestAlert.severity}` : 'No active alert evidence',
      tone: statusTone(unacknowledgedAlerts.length, 1, 3),
    },
    { label: 'Failure Risk', value: `${risk}%`, context: 'Latest composite risk', tone: statusTone(risk, 45, 70) },
    { label: 'Fuel Loss Est.', value: `${estimatedFuelLoss.toFixed(1)} m3/hr`, context: 'Report estimate vs 87% baseline' },
    { label: 'Interventions', value: String(interventionEvents.length), context: 'Control actions logged' },
  ];

  // Icons keyed by KPI label (screen only — not part of the PDF payload).
  const kpiIcons: Record<string, ReactNode> = {
    'Anomalies': <Activity size={13} />,
    'Work Orders': <Wrench size={13} />,
    'Open Alerts': <Bell size={13} />,
    'Failure Risk': <ShieldAlert size={13} />,
    'Fuel Loss Est.': <Flame size={13} />,
    'Interventions': <Zap size={13} />,
  };

  const [exporting, setExporting] = useState(false);
  const [isReviewed, setIsReviewed] = useState(false);

  function buildReportData(): ReportData {
    return {
      asset: 'BOILER-01',
      shiftLabel: currentShift?.shift_label || 'Current shift',
      generatedAt: new Date(),
      reportReady,
      handoverState: reportReady ? 'Validated shift record' : 'Open items remain',
      handoverNote: latestShiftReport
        ? `Latest AI shift report generated at ${latestShiftReport.timestamp}.`
        : 'No AI shift report has been generated yet. Generate the end-of-shift report from AI Advisor for a complete handover.',
      meta: metaItems.map(({ label, value }) => ({ label, value })),
      kpis: kpiItems,
      flueKpis: flueKpiItems,
      shiftSummary: shiftSummary
        ? shiftSummary.replace(/\s+/g, ' ').trim()
        : 'No AI shift summary is available yet. Generate the end-of-shift report from AI Advisor to populate the handover narrative.',
      latestIncident: latestDiagnosis ? getDiagnosisTitle(latestDiagnosis) : undefined,
      followUps: followUps.map((f) => ({ label: f.label, detail: f.detail })),
      events: eventRows.map((e) => ({ time: e.time, label: e.label, detail: e.detail, badge: e.badge })),
    };
  }

  async function handleExportPdf() {
    if (exporting) return;
    setExporting(true);
    try {
      await generateReportPdf(buildReportData());
    } catch (err) {
      console.error('[Reports] PDF export failed', err);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="reports-page">
      <section className="card reports-hero-card">
        <div className="ops-panel-header reports-hero-header">
          <div>
            <h2>Shift Handover Report</h2>
            <p>Summarized evidence, unresolved follow-ups, and export-ready shift context for BOILER-01</p>
            <span className="reports-hero-provenance">
              {reportReady ? <ShieldCheck size={12} /> : <AlertTriangle size={12} />}
              {latestShiftReport
                ? `Latest AI report generated at ${latestShiftReport.timestamp}`
                : 'No AI shift report has been generated yet'}
            </span>
          </div>
          <span className={`audit-pill report-ready-pill ${reportReady ? 'ok' : 'warn'}`}>
            {reportReady ? 'Ready for review' : 'Needs review'}
          </span>
        </div>

        <div className="reports-hero-body">
          <div className="reports-context-grid">
            {metaItems.map((m) => (
              <div key={m.label}>
                <span>{m.label}</span>
                <strong className={m.tone ? `report-tone-${m.tone}` : undefined}>{m.value}</strong>
              </div>
            ))}
          </div>

          <div className="reports-action-row" aria-label="Report actions">
            <button type="button" title="Export shift handover PDF" onClick={handleExportPdf} disabled={exporting}>
              <Download size={15} /> {exporting ? 'Generating...' : 'PDF'}
            </button>
            <button 
              type="button" 
              title="Mark handover reviewed" 
              onClick={() => setIsReviewed(true)}
              disabled={isReviewed}
              className={isReviewed ? 'reviewed-active' : ''}
              style={isReviewed ? { color: '#22c55e', borderColor: '#22c55e', background: 'rgba(34, 197, 94, 0.1)' } : undefined}
            >
              {isReviewed ? <CheckCircle2 size={15} /> : <ClipboardCheck size={15} />} Reviewed
            </button>
          </div>
        </div>
      </section>

      <section className="reports-kpi-grid" aria-label="Report summary metrics">
        {kpiItems.map((k) => (
          <div className={`inner-card report-kpi-card${k.tone ? ` tone-${k.tone}` : ''}`} key={k.label}>
            <span>{kpiIcons[k.label]}{k.label}</span>
            <strong className={k.tone ? `report-tone-${k.tone}` : undefined}>{k.value}</strong>
            <em>{k.context}</em>
          </div>
        ))}
      </section>

      <section className="reports-flue-summary" aria-label="Flue path report summary">
        <div className="reports-section-head">
          <div>
            <h2>Flue Path Summary</h2>
            <p>Alarm recurrence, latest draft excursion, and damper response evidence</p>
          </div>
          <span className="audit-pill">Natural draft</span>
        </div>
        <div className="reports-flue-kpi-grid">
          {flueKpiItems.map((k) => (
            <div className={`inner-card report-kpi-card${k.tone ? ` tone-${k.tone}` : ''}`} key={k.label}>
              <span>
                {k.label === 'Flue Alarms' ? <Wind size={13} />
                  : k.label === 'Active Flue Alarms' ? <AlertTriangle size={13} />
                    : k.label === 'Worst Furnace Pressure' ? <Gauge size={13} />
                      : <SlidersHorizontal size={13} />}
                {k.label}
              </span>
              <strong className={k.tone ? `report-tone-${k.tone}` : undefined}>{k.value}</strong>
              <em>{k.context}</em>
            </div>
          ))}
        </div>
      </section>

      <section className="reports-main-grid">
        <div className="card reports-ai-card">
          <div className="ops-panel-header">
            <div>
              <h2>AI Shift Summary</h2>
              <p>Report narrative and operator follow-up context</p>
            </div>
            <span className="status-pill ai"><Sparkles size={12} /> AI</span>
          </div>
          <div className="reports-card-body">
            {shiftSummary ? (
              <>
                <p className="reports-summary-copy">{truncate(shiftSummary, 520)}</p>
                {latestDiagnosis && (
                  <div className="operator-action reports-latest-diagnosis">
                    <span>Latest Incident Card</span>
                    <p>{truncate(getDiagnosisTitle(latestDiagnosis), 180)}</p>
                  </div>
                )}
              </>
            ) : (
              <div className="reports-empty-state">
                <FileText size={18} />
                <strong>No shift report generated</strong>
                <p>Use AI Advisor to generate the end-of-shift report. This page will show the handover summary after it arrives.</p>
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="ops-panel-header">
            <div>
              <h2>Open Follow-ups</h2>
              <p>Items that should survive the dashboard refresh cycle</p>
            </div>
            <span className="audit-pill">{followUps.length}</span>
          </div>
          <div className="reports-card-body reports-followup-list">
            {followUps.length ? followUps.map((item, index) => (
              <div className={`reports-followup-item tone-${item.tone}`} key={`${item.label}-${index}`}>
                <CheckCircle2 size={15} />
                <div>
                  <strong>{item.label}</strong>
                  <span>{item.detail}</span>
                </div>
              </div>
            )) : (
              <div className="reports-empty-state compact">
                <CheckCircle2 size={17} />
                <strong>No open follow-ups</strong>
                <p>Alerts are acknowledged and no AI follow-up list is pending.</p>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="card">
        <div className="ops-panel-header">
          <div>
            <h2>Key Events Timeline</h2>
            <p>Alerts, AI diagnoses, and interventions consolidated for handover review</p>
          </div>
          <span className="audit-pill">Evidence</span>
        </div>
        <div className="reports-card-body reports-timeline">
          {eventRows.length ? eventRows.map((event) => (
            <div className={`reports-timeline-row tone-${event.tone}`} key={event.id}>
              <div className="reports-timeline-marker" />
              <time>{event.time}</time>
              <div>
                <strong>{event.label}</strong>
                <span>{event.detail}</span>
              </div>
              <em>{event.badge}</em>
            </div>
          )) : (
            <div className="reports-empty-state compact">
              <RadioTower size={17} />
              <strong>No reportable events yet</strong>
              <p>Anomalies, diagnoses, alerts, and interventions will appear here as audit evidence.</p>
            </div>
          )}
        </div>
      </section>

      <details className="reports-raw-evidence">
        <summary>Raw telemetry evidence</summary>
        <MqttStream />
      </details>
    </div>
  );
}
