'use client';

import { useNexusStore } from '@/lib/store';
import { calcDerivedMetrics } from '@/lib/utils';

// ─── helpers ───────────────────────────────────────────────────────────────

interface TagRowProps {
  label: string;
  value: string;
  status?: 'ok' | 'warn' | 'crit' | 'neutral';
  last?: boolean;
}

const STATUS_COLOR: Record<string, string> = {
  ok:      'var(--tx-value)',
  warn:    '#fbbf24',
  crit:    '#ef4444',
  neutral: 'var(--tx-value)',
};

function TagRow({ label, value, status = 'neutral', last }: TagRowProps) {
  return (
    <div
      className={`tag-row flex justify-between ${last ? 'pb-1 pt-1' : 'border-b pb-2 pt-1'}`}
      style={{ borderBottomColor: 'rgba(63,63,70,0.4)' }}
    >
      <span className="tag-label text-[13px] font-medium" style={{ color: 'var(--tx-label)' }}>
        {label}
      </span>
      <span
        className="tag-value digit text-[13px] font-medium"
        style={{ color: STATUS_COLOR[status] }}
      >
        {value}
      </span>
    </div>
  );
}

function SectionHead({ label }: { label: string }) {
  return (
    <div
      className="text-[9px] font-bold uppercase tracking-widest pt-3 pb-1"
      style={{ color: 'var(--tx-muted)', letterSpacing: '0.1em' }}
    >
      {label}
    </div>
  );
}

// ─── component ─────────────────────────────────────────────────────────────

export function LiveTags() {
  const { tags, anomalyScore } = useNexusStore();
  const t = tags;

  const mlStatus    = anomalyScore > 70 ? 'ANOMALY' : anomalyScore > 30 ? 'ELEVATED' : 'NORMAL';
  const mlStatusCls = anomalyScore > 70
    ? 'text-red-400 font-bold animate-pulse'
    : anomalyScore > 30 ? 'text-amber-400 font-bold' : 'text-emerald-400 font-bold';
  const mlBarCls    = anomalyScore > 70 ? 'bg-red-500' : anomalyScore > 30 ? 'bg-amber-500' : 'bg-emerald-500';

  const d = t ? calcDerivedMetrics(t) : null;

  // ── status helpers ─────────────────────────────────────────────────────────
  const pStatus  = !t ? 'neutral' : t.steam_pressure > 13 ? 'crit' : t.steam_pressure > 12 ? 'warn' : 'ok';
  const lvlStatus = !t ? 'neutral'
    : t.drum_level < 200 || t.drum_level > 720 ? 'crit'
    : t.drum_level < 280 || t.drum_level > 600 ? 'warn'
    : 'ok';
  const o2Status  = !t ? 'neutral' : t.o2_percent < 2 || t.o2_percent > 5.5 ? 'crit' : t.o2_percent > 4 ? 'warn' : 'ok';
  const fgtStatus = !t ? 'neutral' : t.flue_gas_temp > 240 ? 'crit' : t.flue_gas_temp > 220 ? 'warn' : 'ok';
  const effStatus = !t ? 'neutral' : t.efficiency < 75 ? 'crit' : t.efficiency < 82 ? 'warn' : 'ok';
  const tubeStatus = !t ? 'neutral' : t.tube_health < 70 ? 'crit' : t.tube_health < 80 ? 'warn' : 'ok';

  const afrStatus = !d ? 'neutral' : d.afr < 9.5 || d.afr > 13 ? 'crit' : d.afr < 10.5 || d.afr > 12 ? 'warn' : 'ok';
  const eaStatus  = !d ? 'neutral' : d.excessAir > 45 || d.excessAir < 5 ? 'crit' : d.excessAir > 30 ? 'warn' : 'ok';
  const pmStatus  = !d ? 'neutral' : d.pressureMargin < 0.5 ? 'crit' : d.pressureMargin < 1.5 ? 'warn' : 'ok';
  const sfStatus  = !d ? 'neutral' : d.steamToFuel < 14 ? 'warn' : 'ok';
  const fwStatus  = !d ? 'neutral' : d.fwToSteam < 0.9 || d.fwToSteam > 1.12 ? 'warn' : 'ok';
  const loadStatus: 'ok' | 'warn' | 'crit' | 'neutral' = !d ? 'neutral' : d.boilerLoad > 100 ? 'crit' : d.boilerLoad > 92 ? 'warn' : 'ok';

  const flameStatus: 'ok' | 'crit' | 'neutral' = !t ? 'neutral' : t.flame_status ? 'ok' : 'crit';
  const svStatus: 'ok' | 'crit' | 'neutral'    = !t ? 'neutral' : t.safety_valve ? 'crit' : 'ok';

  return (
    <div id="live-tags-card" className="live-tags-card card p-6">
      <h3 className="text-xs uppercase tracking-widest mb-4 font-bold" style={{ color: '#a16207' }}>
        All Live Tags
      </h3>

      {/* ML Anomaly Score */}
      <div className="mb-4 p-3 rounded-lg" style={{ background: 'var(--ai-think-bg)', border: '1px solid var(--accent-border)' }}>
        <div className="flex justify-between text-xs mb-2">
          <span className="font-semibold uppercase tracking-wider" style={{ color: 'var(--tx-muted)' }}>
            ML Anomaly Score
          </span>
          <span className={mlStatusCls}>{mlStatus}</span>
        </div>
        <div className="h-2 rounded-full overflow-hidden mb-2" style={{ background: 'var(--bd-stream)' }}>
          <div className={`h-full rounded-full transition-all duration-500 ${mlBarCls}`} style={{ width: `${anomalyScore}%` }} />
        </div>
        <div className="text-[10px] font-medium" style={{ color: 'var(--tx-muted)' }}>
          Isolation Forest v1.0 · Real-time inference
        </div>
      </div>

      <div className="space-y-0 text-[13px] font-medium">

        {/* ── STEAM SIDE ───────────────────────────────────────────── */}
        <SectionHead label="Steam" />
        <TagRow label="Pressure"       value={t ? `${t.steam_pressure.toFixed(2)} bar` : '--'} status={pStatus} />
        <TagRow label="Temperature"    value={t ? `${t.steam_temperature.toFixed(1)} °C` : '--'} />
        <TagRow label="Flow"           value={t ? `${Math.round(t.steam_flow)} kg/hr` : '--'} />
        <TagRow label="Boiler Load"    value={d ? `${d.boilerLoad.toFixed(1)} %` : '--'} status={loadStatus} />
        <TagRow label="Pressure Margin" value={d ? `${d.pressureMargin.toFixed(2)} bar to SV` : '--'} status={pmStatus} />

        {/* ── WATER SIDE ───────────────────────────────────────────── */}
        <SectionHead label="Water" />
        <TagRow label="Drum Level"     value={t ? `${Math.round(t.drum_level)} mm` : '--'} status={lvlStatus} />
        <TagRow label="Feedwater Flow" value={t ? `${Math.round(t.feedwater_flow)} kg/hr` : '--'} />
        <TagRow label="Feedwater Temp" value={t ? `${t.feedwater_temp.toFixed(1)} °C` : '--'} />
        <TagRow label="FW/Steam Ratio" value={d ? d.fwToSteam.toFixed(3) : '--'} status={fwStatus} />

        {/* ── COMBUSTION ───────────────────────────────────────────── */}
        <SectionHead label="Combustion" />
        <TagRow label="Fuel Flow"      value={t ? `${t.fuel_flow.toFixed(1)} m³/hr` : '--'} />
        <TagRow label="Air/Fuel Ratio" value={d ? `${d.afr.toFixed(2)} : 1` : '--'} status={afrStatus} />
        <TagRow label="O₂ %"          value={t ? `${t.o2_percent.toFixed(2)} %` : '--'} status={o2Status} />
        <TagRow label="Excess Air"     value={d ? `${d.excessAir.toFixed(1)} %` : '--'} status={eaStatus} />
        <TagRow label="Flue Gas Temp"  value={t ? `${t.flue_gas_temp.toFixed(1)} °C` : '--'} status={fgtStatus} />

        {/* ── KPIs ─────────────────────────────────────────────────── */}
        <SectionHead label="Performance KPIs" />
        <TagRow label="Efficiency"     value={t ? `${t.efficiency.toFixed(1)} %` : '--'} status={effStatus} />
        <TagRow label="Heat Rate"      value={t ? `${Math.round(t.heat_rate)} kJ/kg` : '--'} />
        <TagRow label="Steam / Fuel"   value={d ? `${d.steamToFuel.toFixed(2)} kg/m³` : '--'} status={sfStatus} />
        <TagRow label="Tube Health"    value={t ? `${t.tube_health.toFixed(1)} %` : '--'} status={tubeStatus} />

        {/* ── SAFETY ───────────────────────────────────────────────── */}
        <SectionHead label="Safety" />
        <TagRow label="Flame Status"   value={t ? (t.flame_status ? 'ON' : 'OFF') : '--'} status={flameStatus} />
        <TagRow label="Safety Valve"   value={t ? (t.safety_valve ? 'OPEN' : 'CLOSED') : '--'} status={svStatus} last />

      </div>
    </div>
  );
}
