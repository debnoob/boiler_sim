/**
 * Shift Handover Report — client-side PDF generator.
 *
 * Architecture: jsPDF 4 + jspdf-autotable 5 produce a real *vector* PDF with
 * selectable text (small file, crisp at any zoom), driven by the structured
 * report data the Reports page already computes. No DOM screenshotting and no
 * server round-trip — this app is a client-only live dashboard.
 *
 * The heavy libraries are dynamically imported inside generateReportPdf() so
 * they stay out of the initial route bundle and only load when an operator
 * actually exports a report.
 */

export type ReportTone = 'ok' | 'warn' | 'crit' | 'info' | 'ai';

export interface ReportKpi {
  label: string;
  value: string;
  context: string;
  tone?: ReportTone;
}

export interface ReportEvent {
  time: string;
  label: string;
  detail: string;
  badge: string;
}

export interface ReportFollowUp {
  label: string;
  detail: string;
}

export interface ReportData {
  asset: string;
  shiftLabel: string;
  generatedAt: Date;
  reportReady: boolean;
  handoverState: string;
  handoverNote: string;
  meta: Array<{ label: string; value: string }>;
  kpis: ReportKpi[];
  shiftSummary: string;
  latestIncident?: string;
  followUps: ReportFollowUp[];
  events: ReportEvent[];
}

// Palette (RGB) — mirrors the dashboard's slate/blue system.
const NAVY: [number, number, number] = [15, 23, 42];
const ACCENT: [number, number, number] = [37, 99, 235];
const INK: [number, number, number] = [30, 41, 59];
const MUTED: [number, number, number] = [100, 116, 139];
const HAIRLINE: [number, number, number] = [226, 232, 240];
const TONE: Record<ReportTone, [number, number, number]> = {
  ok: [22, 163, 74],
  warn: [202, 138, 4],
  crit: [220, 38, 38],
  info: [37, 99, 235],
  ai: [124, 58, 237],
};

function fmtTimestamp(date: Date) {
  // Deterministic, locale-stable "08 Jul 2026, 14:32" style label.
  const pad = (n: number) => String(n).padStart(2, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${pad(date.getDate())} ${months[date.getMonth()]} ${date.getFullYear()}, ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

function slugForFile(date: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(
    date.getMinutes(),
  )}`;
}

export async function generateReportPdf(data: ReportData): Promise<void> {
  const [{ jsPDF }, autoTableMod] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const autoTable = autoTableMod.default;

  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const M = 14; // page margin
  const contentW = pageW - M * 2;

  // ── Header band ─────────────────────────────────────────────────────────
  doc.setFillColor(...NAVY);
  doc.rect(0, 0, pageW, 26, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text('NEXUS OS', M, 12);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(191, 219, 254);
  doc.text('Shift Handover Report', M, 18.5);
  // Right-aligned asset + readiness pill.
  doc.setFontSize(9);
  doc.setTextColor(226, 232, 240);
  doc.text(`${data.asset}  ·  ${data.shiftLabel}`, pageW - M, 12, { align: 'right' });
  const pill = data.reportReady ? 'READY FOR REVIEW' : 'NEEDS REVIEW';
  const pillColor = data.reportReady ? TONE.ok : TONE.warn;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  const pillW = doc.getTextWidth(pill) + 6;
  doc.setFillColor(...pillColor);
  doc.roundedRect(pageW - M - pillW, 15.2, pillW, 5.4, 1.2, 1.2, 'F');
  doc.setTextColor(255, 255, 255);
  doc.text(pill, pageW - M - pillW / 2, 18.9, { align: 'center' });

  let y = 34;

  // ── Handover status line ────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...INK);
  doc.text(data.handoverState, M, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  doc.text(`Generated ${fmtTimestamp(data.generatedAt)}`, pageW - M, y, { align: 'right' });
  y += 5;
  const noteLines = doc.splitTextToSize(data.handoverNote, contentW);
  doc.text(noteLines, M, y);
  y += noteLines.length * 4 + 3;

  // Meta chips row (mode / mqtt / messages / window)
  doc.setDrawColor(...HAIRLINE);
  doc.setLineWidth(0.2);
  doc.line(M, y, pageW - M, y);
  y += 5;
  const chipW = contentW / data.meta.length;
  data.meta.forEach((chip, i) => {
    const cx = M + chipW * i;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...MUTED);
    doc.text(chip.label.toUpperCase(), cx, y);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(...INK);
    doc.text(chip.value, cx, y + 5);
  });
  y += 11;

  // ── Section: Report Summary KPIs ────────────────────────────────────────
  sectionHeading(doc, 'Report Summary', M, y);
  y += 3;
  autoTable(doc, {
    startY: y,
    margin: { left: M, right: M },
    head: [['Metric', 'Value', 'Context']],
    body: data.kpis.map((k) => [k.label, k.value, k.context]),
    theme: 'grid',
    headStyles: { fillColor: NAVY, textColor: 255, fontSize: 9, halign: 'left', cellPadding: 2 },
    bodyStyles: { fontSize: 9, textColor: INK, cellPadding: 2 },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles: {
      0: { cellWidth: 42, fontStyle: 'bold' },
      1: { cellWidth: 32, fontStyle: 'bold' },
      2: { textColor: MUTED },
    },
    didParseCell: (hook) => {
      if (hook.section === 'body' && hook.column.index === 1) {
        const tone = data.kpis[hook.row.index]?.tone;
        if (tone) hook.cell.styles.textColor = TONE[tone];
      }
    },
  });
  y = afterTable(doc) + 7;

  // ── Section: AI Shift Summary ───────────────────────────────────────────
  y = ensureSpace(doc, y, 30, M, pageH);
  sectionHeading(doc, 'AI Shift Summary', M, y);
  y += 6;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(...INK);
  const summaryLines = doc.splitTextToSize(data.shiftSummary, contentW);
  summaryLines.forEach((line: string) => {
    y = ensureSpace(doc, y, 6, M, pageH);
    doc.text(line, M, y);
    y += 4.6;
  });
  if (data.latestIncident) {
    y += 2;
    y = ensureSpace(doc, y, 14, M, pageH);
    doc.setFillColor(245, 243, 255);
    doc.setDrawColor(...TONE.ai);
    const incLines = doc.splitTextToSize(data.latestIncident, contentW - 8);
    const boxH = incLines.length * 4.4 + 9;
    doc.setLineWidth(0.4);
    doc.roundedRect(M, y, contentW, boxH, 1.5, 1.5, 'FD');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(...TONE.ai);
    doc.text('LATEST INCIDENT CARD', M + 4, y + 5);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...INK);
    doc.text(incLines, M + 4, y + 10);
    y += boxH + 7;
  } else {
    y += 5;
  }

  // ── Section: Key Events Timeline ────────────────────────────────────────
  y = ensureSpace(doc, y, 24, M, pageH);
  sectionHeading(doc, 'Key Events Timeline', M, y);
  y += 3;
  autoTable(doc, {
    startY: y,
    margin: { left: M, right: M },
    head: [['Time', 'Event', 'Detail', 'Type']],
    body: data.events.length
      ? data.events.map((e) => [e.time, e.label, e.detail, e.badge])
      : [['—', 'No reportable events this shift', 'Anomalies, diagnoses and interventions appear here', '—']],
    theme: 'striped',
    headStyles: { fillColor: NAVY, textColor: 255, fontSize: 9, cellPadding: 2 },
    bodyStyles: { fontSize: 8.5, textColor: INK, cellPadding: 2, valign: 'top' },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles: {
      0: { cellWidth: 22, textColor: MUTED },
      1: { cellWidth: 52, fontStyle: 'bold' },
      2: { cellWidth: 'auto', textColor: MUTED },
      3: { cellWidth: 22, halign: 'center', fontSize: 7.5 },
    },
  });
  y = afterTable(doc) + 7;

  // ── Section: Open Follow-ups ────────────────────────────────────────────
  y = ensureSpace(doc, y, 24, M, pageH);
  sectionHeading(doc, 'Open Follow-ups', M, y);
  y += 3;
  autoTable(doc, {
    startY: y,
    margin: { left: M, right: M },
    head: [['#', 'Follow-up', 'Detail']],
    body: data.followUps.length
      ? data.followUps.map((f, i) => [String(i + 1), f.label, f.detail])
      : [['—', 'No open follow-ups', 'Alerts acknowledged; no pending AI follow-up list']],
    theme: 'grid',
    headStyles: { fillColor: NAVY, textColor: 255, fontSize: 9, cellPadding: 2 },
    bodyStyles: { fontSize: 9, textColor: INK, cellPadding: 2 },
    columnStyles: {
      0: { cellWidth: 10, halign: 'center', textColor: MUTED },
      1: { cellWidth: 60, fontStyle: 'bold' },
      2: { textColor: MUTED },
    },
  });
  y = afterTable(doc) + 10;

  // ── Sign-off block ──────────────────────────────────────────────────────
  y = ensureSpace(doc, y, 34, M, pageH);
  sectionHeading(doc, 'Handover Sign-off', M, y);
  y += 8;
  doc.setDrawColor(...MUTED);
  doc.setLineWidth(0.3);
  const colW = (contentW - 10) / 2;
  const signRow = (label: string, x: number, yy: number) => {
    doc.line(x, yy, x + colW, yy);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text(label, x, yy + 4);
  };
  signRow('Outgoing operator (name & signature)', M, y);
  signRow('Incoming operator (name & signature)', M + colW + 10, y);
  y += 16;
  signRow('Shift supervisor (name & signature)', M, y);
  signRow('Date / time reviewed', M + colW + 10, y);

  // ── Footer + page numbers (added after all pages exist) ─────────────────
  const pageCount = doc.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setDrawColor(...HAIRLINE);
    doc.setLineWidth(0.2);
    doc.line(M, pageH - 12, pageW - M, pageH - 12);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...MUTED);
    doc.text('NEXUS OS · Confidential — for authorized plant operations personnel', M, pageH - 7.5);
    doc.text(`Page ${p} of ${pageCount}`, pageW - M, pageH - 7.5, { align: 'right' });
  }

  doc.save(`nexus-shift-handover-${slugForFile(data.generatedAt)}.pdf`);
}

// ── helpers ────────────────────────────────────────────────────────────────
function sectionHeading(doc: import('jspdf').jsPDF, text: string, x: number, y: number) {
  doc.setFillColor(...ACCENT);
  doc.rect(x, y - 3.4, 2.2, 4.4, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...INK);
  doc.text(text, x + 5, y);
}

// Read the Y position just below the most recent autoTable.
function afterTable(doc: import('jspdf').jsPDF): number {
  const last = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable;
  return last ? last.finalY : 40;
}

// Add a page if `needed` mm won't fit; return the (possibly reset) cursor.
function ensureSpace(doc: import('jspdf').jsPDF, y: number, needed: number, margin: number, pageH: number): number {
  if (y + needed > pageH - 16) {
    doc.addPage();
    return margin + 6;
  }
  return y;
}
