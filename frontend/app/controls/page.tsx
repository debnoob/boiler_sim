'use client';

import { useMemo } from 'react';
import { GripHorizontal, Lock, Cpu } from 'lucide-react';
import { useNexusStore } from '@/lib/store';
import { ArcGauge, RadialGauge, TrimBar, SegRing } from '@/components/controls/Instruments';
import type { ControlActionPayload } from '@/types/telemetry';

export default function ControlsPage() {
  const {
    controlState, controlActions, interventionEvents, forecastDeadline, tags,
  } = useNexusStore();

  const isActive = controlState?.autopilot ?? false;

  // Tube life saved this shift: current ETA vs ETA at first intervention.
  const tubeLifeSaved = useMemo(() => {
    const first = interventionEvents[0];
    if (!first?.forecastDeadlineAtDetection || forecastDeadline == null) return null;
    const delta = forecastDeadline - first.forecastDeadlineAtDetection;
    if (delta <= 60) return null;
    const h = Math.floor(delta / 3600);
    const m = Math.floor((delta % 3600) / 60);
    return h > 0 ? `+${h}h ${m}m` : `+${m}m`;
  }, [interventionEvents, forecastDeadline]);

  const actions = [...controlActions].reverse();

  return (
    <div className="page-body cc-page">

      {/* ── Hero: AI Autopilot status band ─────────────────────────── */}
      <section className={`cc-hero ${isActive ? 'active' : ''}`}>
        <div className="cc-hero-main">
          <div className="cc-loop" aria-hidden="true">
            <span className="cc-loop-ring outer" />
            <span className="cc-loop-ring inner" />
            <span className={`cc-loop-core ${isActive ? 'pulsing' : ''}`} />
          </div>
          <div className="cc-hero-id">
            <div className="cc-hero-title">
              <h2>Autonomous Control</h2>
              <span className={`cc-state-chip ${isActive ? 'on' : ''}`}>
                <i /> {isActive ? 'Closed loop active' : 'Standby'}
              </span>
            </div>
            <p className="cc-hero-sub">
              Closed-loop AI autopilot &middot; {controlActions.length} action(s) this session
              {interventionEvents.length > 0 && ` · ${interventionEvents.length} intervention event(s)`}
            </p>
          </div>
        </div>

        <div className="cc-hero-metrics">
          <div className="cc-metric">
            <span>Efficiency</span>
            <strong>{tags ? tags.efficiency.toFixed(1) : '--'}<i>%</i></strong>
          </div>
          <div className="cc-metric">
            <span>Tube Health</span>
            <strong>{tags ? tags.tube_health.toFixed(1) : '--'}<i>%</i></strong>
          </div>
          <div className={`cc-metric accent ${tubeLifeSaved ? 'lit' : ''}`}>
            <span>Tube Life Saved</span>
            <strong>{tubeLifeSaved ?? '—'}<i>{tubeLifeSaved ? 'shift' : ''}</i></strong>
          </div>
        </div>
      </section>

      {/* ── Precision setpoint instruments ─────────────────────────── */}
      <section className="cc-section-head">
        <div className="cc-section-title"><Cpu size={14} /> <h3>Precision Setpoints</h3></div>
        <span className="cc-section-note">Live control-loop targets</span>
      </section>

      <div className="cc-inst-grid">
        <ArcGauge
          label="Excess O₂ Target" unit="%" value={controlState?.o2_setpoint ?? null}
          min={0} max={5} decimals={1} tone="accent"
          nominalFrom={1.5} nominalTo={3}
          foot={controlState ? 'Nominal' : undefined}
        />
        <RadialGauge
          label="Steam Pressure SP" unit="bar" value={controlState?.pressure_setpoint ?? null}
          min={8} max={14} sp={controlState?.pressure_setpoint} decimals={1} warnFrac={0.75}
        />
        <TrimBar label="Firing-Rate Trim" reductionPct={controlState?.firing_reduction_pct ?? null} span={40} />
        <SegRing label="Soot-Blow Sequence" count={controlState?.soot_blows ?? null} total={8} />
      </div>

      {/* ── Lower grid: intervention timeline + supervision ────────── */}
      <div className="cc-lower">
        <section className="card cc-timeline-panel">
          <div className="ops-panel-header">
            <div>
              <h2>Intervention Timeline</h2>
              <p>Operator-visible autonomous action trail</p>
            </div>
            <span className="audit-pill">{isActive ? 'Autopilot active' : 'Manual supervision'}</span>
          </div>
          <div className="cc-timeline">
            {actions.length === 0 ? (
              <div className="rail-empty">No AI control action applied this session — plant within nominal parameters.</div>
            ) : (
              <>
                <span className="cc-tl-spine" aria-hidden="true" />
                {actions.map((a, i) => <TimelineItem key={i} action={a} latest={i === 0} />)}
              </>
            )}
          </div>
        </section>

        <section className="card cc-supervision">
          <div className="ops-panel-header">
            <div>
              <h2>Supervision</h2>
              <p>Setpoint snapshot &amp; manual override</p>
            </div>
            <Lock size={15} color="var(--tx-muted)" />
          </div>
          <div className="cc-sup-grid">
            <div><span>O₂ Setpoint</span><strong>{controlState ? `${controlState.o2_setpoint.toFixed(1)}%` : '--'}</strong></div>
            <div><span>Pressure SP</span><strong>{controlState ? `${controlState.pressure_setpoint.toFixed(1)} bar` : '--'}</strong></div>
            <div><span>Firing Trim</span><strong>{controlState ? `-${controlState.firing_reduction_pct}%` : '--'}</strong></div>
            <div><span>Soot Blows</span><strong>{controlState ? controlState.soot_blows : '--'}</strong></div>
          </div>
          <button className="cc-override-btn" type="button">
            <GripHorizontal size={15} /> Request Manual Control
          </button>
          <p className="cc-sup-note">Autopilot retains authority until an operator assumes manual control.</p>
        </section>
      </div>
    </div>
  );
}

/* ── Timeline row ───────────────────────────────────────────────────── */
function TimelineItem({ action, latest }: { action: ControlActionPayload; latest: boolean }) {
  const fuelCut = action.firing_reduction_pct;
  const tone = latest ? 'accent' : action.soot_blow ? 'good' : 'muted';
  return (
    <div className={`cc-tl-item ${latest ? 'latest' : ''}`}>
      <span className={`cc-tl-dot ${tone}`} />
      <div className="cc-tl-body">
        <div className="cc-tl-top">
          <strong>{action.headline}</strong>
          <span className="cc-tl-time">{action.timestamp}</span>
        </div>
        {action.reason && <p className="cc-tl-reason">{action.reason}</p>}
        <div className="cc-tl-tags">
          {fuelCut > 0 && <span className="cc-tag warn">Fuel -{fuelCut}%</span>}
          {action.setpoints?.o2_percent != null && <span className="cc-tag accent">O₂ → {action.setpoints.o2_percent.toFixed(1)}%</span>}
          {action.setpoints?.steam_pressure_bar != null && <span className="cc-tag violet">P → {action.setpoints.steam_pressure_bar.toFixed(1)} bar</span>}
          {action.soot_blow && <span className="cc-tag good">Soot blow</span>}
          {action.degradation_slope_reduction_pct > 0 && <span className="cc-tag amber">Slope -{action.degradation_slope_reduction_pct}%</span>}
        </div>
        {action.before && (
          <div className="cc-tl-diff">
            <Diff label="FGT" value={`${action.before.flue_gas_temp.toFixed(1)}°C`} />
            <Diff label="Eff" value={`${action.before.efficiency.toFixed(1)}%`} />
            <Diff label="Tube" value={`${action.before.tube_health.toFixed(1)}%`} />
            <Diff label="Fuel" value={`${action.before.fuel_flow.toFixed(0)} m³/h`} />
          </div>
        )}
      </div>
    </div>
  );
}

function Diff({ label, value }: { label: string; value: string }) {
  return (
    <div className="cc-diff">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
