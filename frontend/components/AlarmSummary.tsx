'use client';

import { useMemo } from 'react';
import { Check, ShieldCheck } from 'lucide-react';
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
    <div className="card" style={{ display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div className="ops-panel-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h2>Active Alarms</h2>
          <p>Prioritised operational events — acknowledge to clear</p>
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

      <div style={{ padding: '0 1.5rem 1.5rem 1.5rem', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Severity count chips */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {(['CRITICAL', 'HIGH', 'WARNING', 'LOW'] as const).map((sev) => {
            const n = counts[sev] ?? 0;
            const color = sevColor(sev);
            const dim = n === 0;
            return (
              <div
                key={sev}
                style={{
                  display: 'flex', alignItems: 'center', gap: 7,
                  padding: '6px 11px', borderRadius: 8,
                  background: dim ? 'var(--bg-elevated)' : `${color}14`,
                  border: `1px solid ${dim ? 'var(--bd-inner)' : `${color}44`}`,
                  opacity: dim ? 0.55 : 1,
                  flex: 1, minWidth: 0,
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
                <span style={{ fontSize: 20, fontWeight: 800, color: dim ? 'var(--tx-muted)' : color, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
                  {n}
                </span>
                <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--tx-muted)' }}>
                  {sev}
                </span>
              </div>
            );
          })}
        </div>

        {/* Latest alarms list */}
        {latest.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {latest.map((a) => {
              const color = sevColor(a.severity);
              return (
                <div
                  key={a.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '9px 12px', borderRadius: 8,
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--bd-inner)',
                    borderLeft: `3px solid ${color}`,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 2 }}>
                      <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.05em', color, textTransform: 'uppercase' }}>
                        {a.severity}
                      </span>
                      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--tx-primary)' }}>{a.tag}</span>
                      <span style={{ fontSize: 10, color: 'var(--tx-muted)', fontVariantNumeric: 'tabular-nums' }}>
                        {a.value.toFixed(1)}
                      </span>
                    </div>
                    <p style={{
                      margin: 0, fontSize: 11, color: 'var(--tx-secondary)', lineHeight: 1.4,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {a.message}
                    </p>
                  </div>
                  <span style={{ fontSize: 9.5, color: 'var(--tx-muted)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                    {new Date(a.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <button
                    onClick={() => acknowledgeAlert(a.id)}
                    title="Acknowledge"
                    style={{
                      flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4,
                      padding: '4px 9px', borderRadius: 6,
                      background: 'var(--bg-surface)', border: '1px solid var(--bd-inner)',
                      color: 'var(--tx-secondary)', fontSize: 10, fontWeight: 700, cursor: 'pointer',
                    }}
                  >
                    <Check size={11} strokeWidth={2.5} />
                    Ack
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '16px', borderRadius: 8,
            background: 'var(--bg-elevated)', border: '1px solid var(--bd-inner)',
            color: 'var(--tx-secondary)', fontSize: 12,
          }}>
            <ShieldCheck size={18} strokeWidth={2} color="#22c55e" style={{ flexShrink: 0 }} />
            <span>No active alarms — all systems operating within nominal parameters.</span>
          </div>
        )}
      </div>
    </div>
  );
}
