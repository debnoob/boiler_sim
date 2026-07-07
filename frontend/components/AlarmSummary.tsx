'use client';

import { useMemo } from 'react';
import { Check, Clock3, ShieldCheck, Siren } from 'lucide-react';
import { useNexusStore } from '@/lib/store';

const SEV_COLOR: Record<string, string> = {
  CRITICAL: '#ef4444',
  HIGH: '#f97316',
  WARNING: '#f59e0b',
  LOW: '#eab308',
};

function sevColor(sev: string) {
  return SEV_COLOR[sev.toUpperCase()] ?? '#f59e0b';
}

export function AlarmSummary() {
  const { alerts, acknowledgedAlertIds, acknowledgeAlert } = useNexusStore();

  const active = useMemo(
    () => alerts.filter((a) => !acknowledgedAlertIds.includes(a.id)).slice().reverse(),
    [alerts, acknowledgedAlertIds],
  );

  const counts = useMemo(() => {
    const c = { CRITICAL: 0, HIGH: 0, WARNING: 0, LOW: 0 } as Record<string, number>;
    active.forEach((a) => {
      const key = a.severity.toUpperCase();
      c[key] = (c[key] ?? 0) + 1;
    });
    return c;
  }, [active]);

  const latest = active.slice(0, 3);

  return (
    <div className="card ov-alarm-feed" style={{ display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div className="ov-section-head">
        <div>
          <h2>Active Alarms</h2>
          <p>Prioritised operational events</p>
        </div>
        <span
          className="audit-pill"
          style={active.length > 0
            ? { background: 'rgba(239,68,68,0.12)', color: '#ef4444', borderColor: '#7f1d1d' }
            : { background: 'rgba(34,197,94,0.10)', color: '#22c55e', borderColor: '#14532d' }}
        >
          {active.length > 0 ? `${active.length} active` : 'All clear'}
        </span>
      </div>

      <div className="ov-alarm-body">
        {/* Severity count chips */}
        <div className="ov-alarm-counts">
          {(['CRITICAL', 'HIGH', 'WARNING', 'LOW'] as const).map((sev) => {
            const n = counts[sev] ?? 0;
            const color = sevColor(sev);
            const dim = n === 0;
            return (
              <div
                key={sev}
                className="ov-alarm-count"
                style={{
                  ['--alarm-color' as string]: color,
                  borderColor: dim ? 'var(--bd-inner)' : `${color}44`,
                  background: dim ? 'var(--bg-elevated)' : `${color}12`,
                  opacity: dim ? 0.55 : 1,
                }}
              >
                <span className="ov-alarm-count-dot" />
                <div>
                  <strong>{n}</strong>
                  <em>{sev}</em>
                </div>
              </div>
            );
          })}
        </div>

        {/* Latest alarms list */}
        {latest.length > 0 ? (
          <div className="ov-event-list">
            <div className="ov-event-list-head">
              <span>Latest events</span>
              <span>Local time</span>
            </div>
            {latest.map((a) => {
              const color = sevColor(a.severity);
              const eventTime = new Date(a.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              return (
                <div
                  key={a.id}
                  className="ov-event-row"
                  style={{ ['--alarm-color' as string]: color }}
                >
                  <div className="ov-event-severity" style={{ background: `${color}16`, borderColor: `${color}44`, color }}>
                    <Siren size={14} strokeWidth={2.2} />
                  </div>
                  <div className="ov-event-main">
                    <div className="ov-event-meta">
                      <span style={{ color }}>{a.severity}</span>
                      <strong>{a.tag}</strong>
                      <em>{a.value.toFixed(1)}</em>
                    </div>
                    <p>{a.message}</p>
                  </div>
                  <span className="ov-event-time">
                    <Clock3 size={11} strokeWidth={2.1} />
                    {eventTime}
                  </span>
                  <button
                    onClick={() => acknowledgeAlert(a.id)}
                    title="Acknowledge alarm"
                    aria-label={`Acknowledge ${a.severity} alarm for ${a.tag}`}
                    className="ov-event-ack"
                  >
                    <Check size={12} strokeWidth={2.5} />
                  </button>
                </div>
              );
            })}
            {active.length > latest.length && (
              <div className="ov-event-more">
                Showing latest {latest.length} of {active.length} active alarms
              </div>
            )}
          </div>
        ) : (
          <div className="ov-event-empty">
            <ShieldCheck size={22} strokeWidth={2} color="#22c55e" style={{ flexShrink: 0 }} />
            <div>
              <strong>All clear</strong>
              <span>No active alarms. Systems are operating within nominal parameters.</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
