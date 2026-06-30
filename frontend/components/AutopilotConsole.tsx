'use client';

import { useNexusStore } from '@/lib/store';
import type { ControlActionPayload } from '@/types/telemetry';

/* ─────────────────────────────────────────────────────────────────────────
   AutopilotConsole
   Visualises the real-time closed-loop AI autopilot that ships in
   ai_analyst.py / boiler_engine.py.  Data arrives via MQTT heartbeat
   (control sub-object) and control_action events.
───────────────────────────────────────────────────────────────────────── */

export function AutopilotConsole() {
  const { controlState, controlActions, interventionEvents, forecastDeadline } = useNexusStore();
  const isActive = controlState?.autopilot ?? false;

  // Total life saved: current ETA vs what ETA was before first intervention
  const firstEvent = interventionEvents[0];
  const totalSavedDisplay = (() => {
    if (!firstEvent?.forecastDeadlineAtDetection || forecastDeadline == null) return null;
    const delta = forecastDeadline - firstEvent.forecastDeadlineAtDetection;
    if (delta <= 60) return null;
    const h = Math.floor(delta / 3600);
    const m = Math.floor((delta % 3600) / 60);
    return h > 0 ? `+${h}h ${m}m` : `+${m}m`;
  })();

  return (
    <div
      style={{
        background: 'var(--bg-elevated)',
        border: `1px solid ${isActive ? 'rgba(74,222,128,0.25)' : 'var(--bd-inner)'}`,
        borderRadius: 12,
        overflow: 'hidden',
        transition: 'border-color 0.4s',
      }}
    >
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 16px',
          borderBottom: '1px solid var(--bd-inner)',
          background: isActive ? 'rgba(16,185,129,0.05)' : 'transparent',
          transition: 'background 0.4s',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ position: 'relative', display: 'inline-flex', width: 8, height: 8 }}>
            {isActive && (
              <span
                style={{
                  position: 'absolute', inset: 0, borderRadius: '50%',
                  background: '#4ade80', opacity: 0.7,
                  animation: 'pulseDot 1.2s ease-in-out infinite',
                }}
              />
            )}
            <span
              style={{
                position: 'relative', width: 8, height: 8, borderRadius: '50%',
                background: isActive ? '#4ade80' : '#52525b',
                display: 'inline-block',
              }}
            />
          </span>
          <span
            style={{
              fontSize: 11, fontWeight: 700, letterSpacing: '0.07em',
              textTransform: 'uppercase' as const,
              color: isActive ? '#4ade80' : 'var(--tx-muted)',
            }}
          >
            AI Autopilot
          </span>
          <span
            style={{
              fontSize: 9, fontWeight: 700, padding: '1px 7px', borderRadius: 20,
              letterSpacing: '0.05em', textTransform: 'uppercase' as const,
              background: isActive ? 'rgba(74,222,128,0.12)' : 'rgba(82,82,91,0.2)',
              color: isActive ? '#4ade80' : '#71717a',
              border: `1px solid ${isActive ? 'rgba(74,222,128,0.25)' : '#3f3f46'}`,
            }}
          >
            {isActive ? 'ACTIVE' : 'STANDBY'}
          </span>
        </div>

        {totalSavedDisplay && (
          <div style={{
            fontSize: 11, fontWeight: 800, padding: '3px 12px', borderRadius: 20,
            background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.3)',
            color: '#4ade80', letterSpacing: '0.02em',
          }}>
            {totalSavedDisplay} tube life saved this shift
          </div>
        )}

        {controlState && isActive ? (
          <div style={{ display: 'flex', gap: 18 }}>
            <Setpoint label="O₂ SP" value={`${controlState.o2_setpoint.toFixed(1)}%`} />
            <Setpoint label="Pressure SP" value={`${controlState.pressure_setpoint.toFixed(1)} bar`} />
            <Setpoint
              label="Firing Red."
              value={`${controlState.firing_reduction_pct.toFixed(0)}%`}
              highlight={controlState.firing_reduction_pct > 0}
            />
            <Setpoint label="Soot Blows" value={String(controlState.soot_blows)} />
          </div>
        ) : (
          <span style={{ fontSize: 11, color: 'var(--tx-muted)', fontStyle: 'italic' }}>
            Monitoring — no intervention needed
          </span>
        )}
      </div>

      {/* ── Action log ─────────────────────────────────────────────── */}
      {controlActions.length === 0 ? (
        <div
          style={{
            padding: '12px 16px',
            fontSize: 11,
            color: 'var(--tx-muted)',
            fontStyle: 'italic',
            textAlign: 'center' as const,
          }}
        >
          No AI control actions this session — plant running within nominal parameters.
        </div>
      ) : (
        <div style={{ maxHeight: 190, overflowY: 'auto', padding: '6px 0' }} className="hide-scrollbar">
          {[...controlActions].reverse().map((action, i) => (
            <ActionRow key={i} action={action} isLatest={i === 0} />
          ))}
        </div>
      )}
    </div>
  );
}

function Setpoint({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div style={{ textAlign: 'right' as const }}>
      <div style={{ fontSize: 9, color: 'var(--tx-muted)', textTransform: 'uppercase' as const, letterSpacing: '0.05em' }}>
        {label}
      </div>
      <div style={{ fontSize: 13, fontWeight: 700, color: highlight ? '#fbbf24' : 'var(--tx-primary)' }}>
        {value}
      </div>
    </div>
  );
}

function ActionRow({ action, isLatest }: { action: ControlActionPayload; isLatest: boolean }) {
  const fuelCut = action.firing_reduction_pct;
  return (
    <div
      style={{
        display: 'flex', gap: 10, padding: '7px 16px',
        borderBottom: '1px solid var(--bd-inner)',
        background: isLatest ? 'rgba(251,191,36,0.04)' : 'transparent',
        alignItems: 'flex-start',
      }}
    >
      <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column' as const, alignItems: 'center', paddingTop: 3 }}>
        <div style={{
          width: 8, height: 8, borderRadius: '50%',
          background: isLatest ? '#fbbf24' : '#3f3f46',
          border: `1.5px solid ${isLatest ? '#fbbf24' : '#52525b'}`,
        }} />
        <div style={{ width: 1, flex: 1, background: 'var(--bd-inner)', marginTop: 3, minHeight: 10 }} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 3 }}>
          <span style={{ fontSize: 11.5, fontWeight: 700, color: isLatest ? '#fbbf24' : 'var(--tx-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
            {action.headline}
          </span>
          <span style={{ fontSize: 9.5, color: 'var(--tx-muted)', flexShrink: 0 }}>{action.timestamp}</span>
        </div>
        {action.reason && (
          <p style={{ fontSize: 10.5, color: 'var(--tx-secondary)', lineHeight: 1.45, marginBottom: 5 }}>
            {action.reason}
          </p>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 5 }}>
          {fuelCut > 0 && <Chip label={`⬇ Fuel −${fuelCut}%`} color="#f97316" />}
          {action.setpoints?.o2_percent != null && <Chip label={`O₂ → ${action.setpoints.o2_percent.toFixed(1)}%`} color="#60a5fa" />}
          {action.setpoints?.steam_pressure_bar != null && <Chip label={`P → ${action.setpoints.steam_pressure_bar.toFixed(1)} bar`} color="#a78bfa" />}
          {action.soot_blow && <Chip label="💨 Soot blow" color="#4ade80" />}
          {action.degradation_slope_reduction_pct > 0 && <Chip label={`Slope −${action.degradation_slope_reduction_pct}%`} color="#fbbf24" />}
        </div>
        {action.before && (
          <div style={{ display: 'flex', gap: 14, marginTop: 5 }}>
            <Micro label="FGT before" value={`${action.before.flue_gas_temp.toFixed(1)}°C`} />
            <Micro label="Efficiency" value={`${action.before.efficiency.toFixed(1)}%`} />
            <Micro label="Tube health" value={`${action.before.tube_health.toFixed(1)}%`} />
            <Micro label="Fuel flow" value={`${action.before.fuel_flow.toFixed(0)} m³/h`} />
          </div>
        )}
      </div>
    </div>
  );
}

function Chip({ label, color }: { label: string; color: string }) {
  return (
    <span style={{
      fontSize: 9.5, fontWeight: 700, padding: '2px 7px', borderRadius: 20,
      background: `${color}18`, color, border: `1px solid ${color}44`,
      letterSpacing: '0.03em', whiteSpace: 'nowrap' as const,
    }}>
      {label}
    </span>
  );
}

function Micro({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 8.5, color: 'var(--tx-muted)', textTransform: 'uppercase' as const, letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--tx-secondary)' }}>{value}</div>
    </div>
  );
}
