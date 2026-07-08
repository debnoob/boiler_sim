'use client';

/* ─────────────────────────────────────────────────────────────────────────
   Precision setpoint instruments for the Autonomous Control console.
   Pure-SVG radial / arc meters driven by live control-loop setpoints.
   All colour comes from CSS design tokens so light + dark themes both work.
───────────────────────────────────────────────────────────────────────── */

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

type Tone = 'accent' | 'good' | 'warn' | 'crit';
const toneVar: Record<Tone, string> = {
  accent: 'var(--accent)',
  good: 'var(--status-ok)',
  warn: 'var(--status-warn)',
  crit: 'var(--status-crit)',
};

/* ── Semi-circle arc gauge (e.g. O2 setpoint) ─────────────────────────── */
export function ArcGauge({
  label, value, unit, min, max, decimals = 1, tone = 'accent', foot, nominalFrom, nominalTo,
}: {
  label: string; value: number | null; unit: string; min: number; max: number;
  decimals?: number; tone?: Tone; foot?: string; nominalFrom?: number; nominalTo?: number;
}) {
  const ARC = 125.6; // path length of a radius-40 semicircle
  const f = value == null ? 0 : clamp01((value - min) / (max - min));
  const stroke = toneVar[tone];

  // optional nominal band overlay
  let band: React.ReactNode = null;
  if (nominalFrom != null && nominalTo != null) {
    const a = clamp01((nominalFrom - min) / (max - min));
    const b = clamp01((nominalTo - min) / (max - min));
    band = (
      <path
        d="M 10 50 A 40 40 0 0 1 90 50" fill="none" stroke="var(--status-ok)"
        strokeWidth={6} strokeOpacity={0.25} strokeLinecap="round"
        strokeDasharray={ARC} strokeDashoffset={ARC * (1 - b)} pathLength={ARC}
        style={{ clipPath: `inset(0 0 0 ${a * 100}%)` }}
      />
    );
  }

  return (
    <div className="cc-inst">
      <div className="cc-inst-head"><span>{label}</span></div>
      <div className="cc-arc-wrap">
        <svg className="cc-arc-svg" viewBox="0 0 100 55">
          <path className="cc-gauge-track" d="M 10 50 A 40 40 0 0 1 90 50" fill="none" strokeWidth={6} strokeLinecap="round" />
          {band}
          <path
            className="cc-gauge-value" d="M 10 50 A 40 40 0 0 1 90 50" fill="none"
            stroke={stroke} strokeWidth={6} strokeLinecap="round"
            strokeDasharray={ARC} strokeDashoffset={ARC * (1 - f)}
          />
        </svg>
        <div className="cc-arc-readout">
          <div className="cc-inst-value">
            {value == null ? '--' : value.toFixed(decimals)}<span className="cc-inst-unit">{unit}</span>
          </div>
          {foot && <div className="cc-inst-foot" style={{ color: stroke }}>{foot}</div>}
        </div>
      </div>
    </div>
  );
}

/* ── Full radial dial (e.g. steam-pressure setpoint) ──────────────────── */
export function RadialGauge({
  label, value, unit, min, max, sp, warnFrac = 0.82, decimals = 1,
}: {
  label: string; value: number | null; unit: string; min: number; max: number;
  sp?: number; warnFrac?: number; decimals?: number;
}) {
  const R = 42, C = 2 * Math.PI * R;
  const f = value == null ? 0 : clamp01((value - min) / (max - min));
  const overWarn = f >= warnFrac;
  const stroke = overWarn ? 'var(--status-warn)' : 'var(--accent)';

  return (
    <div className="cc-inst">
      <div className="cc-inst-head"><span>{label}</span></div>
      <div className="cc-radial-wrap">
        <svg className="cc-radial-svg" viewBox="0 0 100 100">
          <circle className="cc-gauge-track" cx="50" cy="50" r={R} fill="none" strokeWidth={4} strokeDasharray="2 4" />
          {/* limit zone marker */}
          <circle
            cx="50" cy="50" r={R} fill="none" stroke="var(--status-crit)" strokeWidth={2}
            strokeDasharray={C} strokeDashoffset={C * (1 - 0.12)} opacity={0.7}
            transform="rotate(-90 50 50)"
          />
          <circle
            className="cc-gauge-value" cx="50" cy="50" r={R} fill="none" stroke={stroke}
            strokeWidth={6} strokeLinecap="round"
            strokeDasharray={C} strokeDashoffset={C * (1 - f)}
            transform="rotate(-90 50 50)"
          />
        </svg>
        <div className="cc-radial-readout">
          <strong className="cc-inst-value">{value == null ? '--' : value.toFixed(decimals)}</strong>
          <span className="cc-inst-unit">{unit}</span>
        </div>
      </div>
      <div className="cc-inst-scale">
        <span>{min}</span>
        {sp != null && <span className="cc-inst-sp">SP {sp.toFixed(decimals)}</span>}
        <span className="cc-crit">{max}</span>
      </div>
    </div>
  );
}

/* ── Center-zero bias bar (firing-rate trim) ──────────────────────────── */
export function TrimBar({
  label, reductionPct, span = 40,
}: { label: string; reductionPct: number | null; span?: number }) {
  const r = reductionPct ?? 0;
  const active = r > 0.05;
  const frac = clamp01(r / span); // portion of the negative half filled
  return (
    <div className="cc-inst">
      <div className="cc-inst-head">
        <span>{label}</span>
        <span className={`cc-adj-chip ${active ? 'on' : ''}`}>{active ? 'ADJ' : 'HOLD'}</span>
      </div>
      <div className="cc-trim-block">
        <div className="cc-trim-value" style={{ color: active ? 'var(--status-warn)' : 'var(--tx-primary)' }}>
          {reductionPct == null ? '--' : r > 0.05 ? `-${r.toFixed(1)}%` : '0.0%'}
        </div>
        <div className="cc-trim-track">
          <span className="cc-trim-center" />
          <span
            className="cc-trim-fill"
            style={{ width: `${frac * 50}%`, right: '50%', background: active ? 'var(--status-warn)' : 'var(--accent)' }}
          />
        </div>
        <div className="cc-trim-scale"><span>-{span}%</span><span>0</span><span>+{span}%</span></div>
      </div>
    </div>
  );
}

/* ── Segmented ring (soot-blow sequence count) ────────────────────────── */
export function SegRing({
  label, count, total = 8,
}: { label: string; count: number | null; total?: number }) {
  const R = 40, C = 2 * Math.PI * R;
  const n = count ?? 0;
  const gap = 6; // deg-ish gap rendered as dash gap
  const seg = C / total;
  const dash = Math.max(0, seg - gap);

  return (
    <div className="cc-inst">
      <div className="cc-inst-head"><span>{label}</span></div>
      <div className="cc-seg-block">
        <div className="cc-seg-ring">
          <svg viewBox="0 0 100 100" className="cc-seg-svg">
            <circle cx="50" cy="50" r={R} fill="none" stroke="var(--bd-inner)" strokeWidth={7}
              strokeDasharray={`${dash} ${gap}`} transform="rotate(-90 50 50)" />
            {Array.from({ length: Math.min(n, total) }).map((_, i) => (
              <circle key={i} cx="50" cy="50" r={R} fill="none"
                stroke={i === (n - 1) % total ? 'var(--accent)' : 'var(--status-ok)'}
                strokeWidth={7} strokeDasharray={`${dash} ${C - dash}`}
                strokeDashoffset={-seg * i} transform="rotate(-90 50 50)" />
            ))}
          </svg>
          <div className="cc-seg-count">{count == null ? '--' : n}</div>
        </div>
        <div className="cc-seg-meta">
          <div><span>Cycles</span><strong>{count == null ? '--' : n}</strong></div>
          <div><span>Mode</span><strong>Auto</strong></div>
        </div>
      </div>
    </div>
  );
}
