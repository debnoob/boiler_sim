'use client';

import { useNexusStore } from '@/lib/store';
import { LiveTags } from '@/components/LiveTags';
import { MqttStream } from '@/components/MqttStream';
import { calcRisk, calcDerivedMetrics } from '@/lib/utils';

export default function ReportsPage() {
  const { tags, degradationFactor, chatMessages, woCount, alerts, interventionEvents } = useNexusStore();

  const risk = tags ? calcRisk(tags, degradationFactor) : 0;
  const derived = tags ? calcDerivedMetrics(tags) : null;
  const latestShiftReport = [...chatMessages].reverse().find(m => m.type === 'shift_report');
  const diagnosisCount = chatMessages.filter(m => m.type === 'diagnosis').length;
  const efficiencyLoss = tags ? Math.max(0, 87 - tags.efficiency) : 0;
  const estimatedFuelLoss = tags && derived ? Math.max(0, efficiencyLoss * tags.fuel_flow * 0.12) : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: '100%' }}>
      {/* Summary */}
      <div className="card">
        <div className="ops-panel-header">
          <div>
            <h2>Operations Report</h2>
            <p>Shift status, work orders, and follow-up summary</p>
          </div>
          <span className="audit-pill">WO-{woCount}</span>
        </div>
        <div className="card-content">
          <div className="kpi-row" style={{ marginBottom: 16 }}>
            <div><span>Work Orders</span><strong>{woCount}</strong></div>
            <div><span>Anomalies</span><strong>{diagnosisCount}</strong></div>
            <div><span>Active Alerts</span><strong>{alerts.length}</strong></div>
          </div>
          <div className="kpi-row" style={{ marginBottom: 16 }}>
            <div><span>Failure Risk</span><strong>{risk}%</strong></div>
            <div><span>Fuel Loss Est.</span><strong>{estimatedFuelLoss.toFixed(1)} m³/hr</strong></div>
            <div><span>Interventions</span><strong>{interventionEvents.length}</strong></div>
          </div>
          <div className="operator-action">
            <span>Shift Report</span>
            <p>
              {latestShiftReport
                ? 'Shift report generated — see AI Advisor for the full breakdown.'
                : 'No shift report yet. Go to AI Advisor and send "Generate the end-of-shift report".'}
            </p>
          </div>
        </div>
      </div>

      <MqttStream />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16 }}>
        <LiveTags />
      </div>
    </div>
  );
}
