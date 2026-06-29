'use client';

import { useNexusStore } from '@/lib/store';
import { AutopilotConsole } from '@/components/AutopilotConsole';

export default function ControlsPage() {
  const { controlState, controlActions, interventionEvents } = useNexusStore();
  const lastAction = controlActions[controlActions.length - 1];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1280 }}>
      <AutopilotConsole />

      <div className="card">
        <div className="ops-panel-header">
          <div>
            <h2>Control Audit</h2>
            <p>Operator-visible autonomous action trail</p>
          </div>
          <span className="audit-pill">
            {controlState?.autopilot ? 'Autopilot active' : 'Manual supervision'}
          </span>
        </div>
        <div className="card-content">
          <div className="kpi-row" style={{ marginBottom: 16 }}>
            <div><span>O₂ Setpoint</span><strong>{controlState ? `${controlState.o2_setpoint.toFixed(1)}%` : '--'}</strong></div>
            <div><span>Pressure SP</span><strong>{controlState ? `${controlState.pressure_setpoint.toFixed(1)} bar` : '--'}</strong></div>
            <div><span>Firing Trim</span><strong>{controlState ? `${controlState.firing_reduction_pct}%` : '--'}</strong></div>
          </div>
          {lastAction ? (
            <div className="control-audit large">
              <strong>{lastAction.headline}</strong>
              <p>{lastAction.reason}</p>
              <span>{interventionEvents.length} intervention event(s) logged this session</span>
            </div>
          ) : (
            <div className="rail-empty">No AI control action applied this session</div>
          )}
        </div>
      </div>
    </div>
  );
}
