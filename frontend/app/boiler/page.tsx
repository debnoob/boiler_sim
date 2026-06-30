'use client';

/**
 * /boiler — preview route for the live 3D boiler cutaway.
 *
 * Additive and isolated: this page and components/BoilerScene.tsx are the only
 * new files. It is intentionally NOT linked in the sidebar yet — reach it by
 * navigating to /boiler. To make it permanent, add one line to the NAV array
 * in components/AppShell.tsx (see the note rendered on the page).
 */

import { BoilerScene } from '@/components/BoilerScene';
import { useNexusStore } from '@/lib/store';

const fmt = (v: number | undefined, d = 0, unit = '') =>
  v == null ? '--' : `${v.toFixed(d)}${unit}`;

export default function BoilerPage() {
  const tags = useNexusStore((s) => s.tags);
  const mode = useNexusStore((s) => s.mode);
  const connected = useNexusStore((s) => s.mqttStatus) === 'connected';

  const rows: Array<{ label: string; value: string }> = [
    { label: 'Drum level', value: fmt(tags?.drum_level, 0, ' mm') },
    { label: 'Tube health', value: fmt(tags?.tube_health, 1, ' %') },
    { label: 'Flame', value: tags ? (tags.flame_status > 0.5 ? 'ON' : 'OFF') : '--' },
    { label: 'Steam pressure', value: fmt(tags?.steam_pressure, 1, ' bar') },
    { label: 'Flue gas', value: fmt(tags?.flue_gas_temp, 0, ' °C') },
    { label: 'O₂', value: fmt(tags?.o2_percent, 2, ' %') },
    { label: 'Efficiency', value: fmt(tags?.efficiency, 1, ' %') },
    { label: 'Feedwater', value: fmt(tags?.feedwater_flow, 1, ' t/h') },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: '100%' }}>
      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="ops-panel-header">
          <div>
            <h2>Boiler 3D Cutaway <span style={badge}>PREVIEW</span></h2>
            <p>Live fire-tube boiler driven by BOILER-01 telemetry — drag to orbit, scroll to zoom</p>
          </div>
          <span className="audit-pill">{mode}</span>
        </div>

        {/* Scene stage. position:relative anchors the absolute canvas + HUD */}
        <div style={{ position: 'relative', height: 560, background: 'radial-gradient(circle at 50% 30%, #11161f 0%, #080b10 100%)' }}>
          <BoilerScene />

          {/* Live readout HUD (top-left) */}
          <div style={hud}>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.08em', color: '#fbbf24', marginBottom: 6 }}>
              LIVE TELEMETRY {connected ? '' : '· (waiting for MQTT)'}
            </div>
            {rows.map((r) => (
              <div key={r.label} style={hudRow}>
                <span style={{ color: '#9aa6b2' }}>{r.label}</span>
                <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{r.value}</strong>
              </div>
            ))}
          </div>

          {/* Legend (bottom-left) */}
          <div style={legend}>
            <Item c="#22c55e" t="Tubes / glow = healthy" />
            <Item c="#f59e0b" t="Amber = degrading" />
            <Item c="#ef4444" t="Red pulse = fault / low level" />
            <Item c="#2563eb" t="Water = drum level" />
            <Item c="#38bdf8" t="Dashed = feedwater flow" />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-content" style={{ fontSize: 12.5, color: 'var(--tx-secondary)', lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--tx-primary)' }}>Preview only — nothing else changed.</strong> This view lives at{' '}
          <code>/boiler</code> and is built from <code>components/BoilerScene.tsx</code>. To pin it into the
          sidebar permanently, add one entry to the <code>NAV</code> array in <code>components/AppShell.tsx</code>:
          <pre style={pre}>{`{ href: '/boiler', label: 'Boiler 3D', icon: Box },  // import { Box } from 'lucide-react'`}</pre>
          Until then it stays completely out of the way of your current demo.
        </div>
      </div>
    </div>
  );
}

function Item({ c, t }: { c: string; t: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 9, height: 9, borderRadius: 2, background: c, flexShrink: 0 }} />
      <span style={{ color: '#9aa6b2' }}>{t}</span>
    </div>
  );
}

const badge: React.CSSProperties = {
  fontSize: 9, fontWeight: 800, letterSpacing: '0.1em', padding: '2px 7px',
  borderRadius: 99, background: 'rgba(161,98,7,0.18)', color: '#fbbf24',
  border: '1px solid rgba(161,98,7,0.4)', verticalAlign: 'middle', marginLeft: 8,
};

const hud: React.CSSProperties = {
  position: 'absolute', top: 14, left: 14, zIndex: 2,
  background: 'rgba(10,14,20,0.72)', backdropFilter: 'blur(6px)',
  border: '1px solid rgba(148,163,184,0.18)', borderRadius: 10,
  padding: '10px 12px', minWidth: 180, fontSize: 11.5, color: '#e2e8f0',
};

const hudRow: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', gap: 16, padding: '2px 0',
};

const legend: React.CSSProperties = {
  position: 'absolute', bottom: 14, left: 14, zIndex: 2,
  background: 'rgba(10,14,20,0.66)', backdropFilter: 'blur(6px)',
  border: '1px solid rgba(148,163,184,0.18)', borderRadius: 10,
  padding: '9px 11px', display: 'flex', flexDirection: 'column', gap: 5, fontSize: 10.5,
};

const pre: React.CSSProperties = {
  marginTop: 8, padding: '8px 10px', borderRadius: 6, background: 'rgba(0,0,0,0.3)',
  border: '1px solid var(--bd-inner)', color: '#c7dcf5', fontSize: 11, overflowX: 'auto',
};
