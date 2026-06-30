import type { TelemetryTags } from '@/types/telemetry';

export interface DerivedMetrics {
  afr: number;            // air_flow / fuel_flow  — target ~11
  excessAir: number;      // (O2 / (20.9 - O2)) × 100  — target 15-25%
  pressureMargin: number; // 13.5 − steam_pressure  — headroom to safety-valve lift
  steamToFuel: number;    // steam_flow / fuel_flow  — baseline ~16.7 kg/m³
  fwToSteam: number;      // feedwater_flow / steam_flow  — should stay ~1.0
  boilerLoad: number;     // steam_flow / 2600 × 100  — % of rated capacity
}

export function calcDerivedMetrics(t: TelemetryTags): DerivedMetrics {
  const afr = t.fuel_flow > 0 ? t.air_flow / t.fuel_flow : 0;
  const o2safe = Math.min(Math.max(t.o2_percent, 0), 20.8);
  const excessAir = (o2safe / (20.9 - o2safe)) * 100;
  const pressureMargin = 13.5 - t.steam_pressure;
  const steamToFuel = t.fuel_flow > 0 ? t.steam_flow / t.fuel_flow : 0;
  const fwToSteam = t.steam_flow > 0 ? t.feedwater_flow / t.steam_flow : 0;
  const boilerLoad = (t.steam_flow / 2600) * 100;
  return { afr, excessAir, pressureMargin, steamToFuel, fwToSteam, boilerLoad };
}

export function formatEta(s: number): string {
  if (s >= 86400) return `~${(s / 86400).toFixed(1)} days`;
  if (s >= 3600) return `~${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  if (s >= 60) return `~${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  return `~${Math.max(Math.round(s), 0)}s`;
}

export function calcRisk(t: TelemetryTags, degradation: number): number {
  let risk = degradation * 100;
  if (t.drum_level < 280) risk += 15;
  if (t.drum_level > 600) risk += 15;
  if (t.drum_level > 720) risk += 10;
  if (t.steam_pressure > 13) risk += 20;
  if (t.tube_health < 70) risk += 10;
  if (t.flame_status === 0) risk = 100;
  return Math.min(Math.round(risk), 99);
}

export function getRiskConfig(risk: number) {
  if (risk < 25) return { color: '#10b981', label: 'Normal', textClass: 'text-emerald-400', barClass: 'bg-emerald-500' };
  if (risk < 50) return { color: '#f59e0b', label: 'Elevated', textClass: 'text-amber-400', barClass: 'bg-amber-500' };
  if (risk < 75) return { color: '#f97316', label: 'High', textClass: 'text-orange-400', barClass: 'bg-orange-500' };
  return { color: '#ef4444', label: 'CRITICAL', textClass: 'text-red-400 font-bold', barClass: 'bg-red-500 animate-pulse' };
}

export interface CombustionAdvice {
  badge: string;
  badgeClass: string;
  html: string;
}

export function getCombustionAdvice(t: TelemetryTags): CombustionAdvice {
  if (!t.flame_status) {
    return {
      badge: 'OFFLINE',
      badgeClass: 'border border-zinc-500/40 text-zinc-400',
      html: 'Burner offline — combustion advisor on standby until flame is re-established.',
    };
  }
  const o2 = t.o2_percent;
  const lambda = 20.9 / (20.9 - Math.min(o2, 20));
  const lambdaOpt = 20.9 / (20.9 - 3.2);
  const airAbove = (lambda / lambdaOpt - 1) * 100;
  const recoverable = Math.max(0, o2 - 3.0) * 0.8;

  if (o2 > 4.0) {
    return {
      badge: o2 > 6 ? 'EXCESS AIR' : 'HIGH O₂',
      badgeClass: o2 > 6
        ? 'bg-red-500/10 text-red-400 border border-red-500/20 animate-pulse'
        : 'bg-amber-500/10 text-amber-400 border border-amber-500/20',
      html: `Air flow ~<span class="sensor-val">${airAbove.toFixed(0)}%</span> above optimal. Trim air damper to reduce excess O₂ from <span class="sensor-val">${o2.toFixed(1)}%</span> → <span class="sensor-val">3.2%</span> and recover ~<span class="sensor-val">${recoverable.toFixed(1)}%</span> efficiency.`,
    };
  }
  if (o2 < 2.0) {
    return {
      badge: 'LOW O₂',
      badgeClass: 'bg-red-500/10 text-red-400 border border-red-500/20 animate-pulse',
      html: `O₂ at <span class="sensor-val">${o2.toFixed(1)}%</span> — below the safe 2–4% band. Increase air flow toward <span class="sensor-val">3.2%</span> O₂ to avoid incomplete combustion and CO formation.`,
    };
  }
  return {
    badge: 'OPTIMAL',
    badgeClass: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20',
    html: `O₂ at <span class="sensor-val">${o2.toFixed(2)}%</span> is inside the optimal 2–4% band. Air-fuel ratio well tuned — no damper trim needed.`,
  };
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Pre-processes a full AI message string before it's split into lines.
 * - Converts markdown tables into clean bullet-list rows
 * - Collapses 3+ blank lines into 2
 * - Strips horizontal rules (---)
 * Returns the cleaned text, ready for line-by-line rendering.
 */
export function preprocessMessage(raw: string): string {
  const lines = raw.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Detect markdown table: line contains pipes and the NEXT line is a separator (---|---)
    const isTableRow = /^\s*\|/.test(line) && line.includes('|');
    const nextIsSep = i + 1 < lines.length && /^\s*\|[\s|:-]+\|/.test(lines[i + 1]);

    if (isTableRow && nextIsSep) {
      // This is the header row — skip header + separator, convert data rows to bullets
      i += 2; // skip header & separator
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        const cells = lines[i]
          .split('|')
          .map(c => c.trim())
          .filter(c => c.length > 0);
        if (cells.length > 0) {
          // Join cells as "Label: Value" or just space-separated if no clear label
          if (cells.length >= 2) {
            out.push(`- **${cells[0]}:** ${cells.slice(1).join(' — ')}`);
          } else {
            out.push(`- ${cells[0]}`);
          }
        }
        i++;
      }
      continue;
    }

    // Also handle loose table rows (no separator — LLM sometimes skips it)
    if (isTableRow && !nextIsSep) {
      const cells = line
        .split('|')
        .map(c => c.trim())
        .filter(c => c.length > 0);
      // If looks like a separator row itself, skip
      if (/^[-:]+$/.test(cells[0])) { i++; continue; }
      if (cells.length >= 2) {
        out.push(`- **${cells[0]}:** ${cells.slice(1).join(' — ')}`);
      } else if (cells.length === 1) {
        out.push(cells[0]);
      }
      i++;
      continue;
    }

    // Strip horizontal rules
    if (/^[-*_]{3,}\s*$/.test(line.trim())) { i++; continue; }

    out.push(line);
    i++;
  }

  // Collapse excessive blank lines
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Converts a SINGLE line of markdown-ish text into inline HTML.
 * Call preprocessMessage() on the full response first, then split on \n
 * and pass each line here.
 * Supports: ## headings, **bold**, *italic*, `code`, sensor-value highlighting.
 */
export function formatRich(text: string): string {
  // Escape HTML first
  let html = escapeHtml(text);

  // Strip leading markdown heading markers (handled by className in the caller)
  html = html.replace(/^#{1,3}\s+/, '');

  // Strip leading bullet/list markers (also handled by className in caller)
  html = html.replace(/^[-*•]\s+/, '');
  html = html.replace(/^\d+\.\s+/, '');

  // Bold **text**
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong class="fr-bold">$1</strong>');

  // Italic *text* (single asterisk, not double)
  html = html.replace(/(?<!\*)\*(?!\*)([^*]+?)(?<!\*)\*(?!\*)/g, '<em class="fr-em">$1</em>');

  // Inline code `text`
  html = html.replace(/`([^`]+)`/g, '<code class="fr-code">$1</code>');

  // Sensor value highlighting (numbers with units)
  html = html.replace(
    /(-?\d+(?:\.\d+)?\s?(?:bar|°C|%|mm|kg\/hr|m³\/hr|m3\/hr|kPa|kW|MW|rpm|ppm|°F))/g,
    '<span class="sensor-val">$1</span>'
  );

  return html;
}
