import * as XLSX from 'xlsx';
import type { NexusStore } from '@/lib/store';
import { calcDerivedMetrics, calcRisk } from '@/lib/utils';

export function exportToPowerBI(state: NexusStore): void {
  const wb = XLSX.utils.book_new();

  // Sheet 1: Snapshot — latest sensor readings + derived KPIs
  if (state.tags) {
    const t = state.tags;
    const derived = calcDerivedMetrics(t);
    const risk = calcRisk(t, state.degradationFactor);
    const ws = XLSX.utils.json_to_sheet([{
      'Timestamp': new Date().toISOString(),
      'Mode': state.mode,
      'Steam_Pressure_bar': t.steam_pressure,
      'Steam_Temperature_C': t.steam_temperature,
      'Steam_Flow_kg_hr': t.steam_flow,
      'Drum_Level_mm': t.drum_level,
      'Feedwater_Flow_kg_hr': t.feedwater_flow,
      'Feedwater_Temp_C': t.feedwater_temp,
      'Fuel_Flow_m3_hr': t.fuel_flow,
      'Air_Flow_m3_hr': t.air_flow,
      'O2_Percent': t.o2_percent,
      'Flue_Gas_Temp_C': t.flue_gas_temp,
      'Tube_Health_Pct': t.tube_health,
      'Efficiency_Pct': t.efficiency,
      'Heat_Rate_kJ_kg': t.heat_rate,
      'Flame_Status': t.flame_status,
      'Safety_Valve': t.safety_valve,
      'Degradation_Factor': state.degradationFactor,
      'Anomaly_Score_Pct': state.anomalyScore,
      'Anomaly_Detected': state.anomalyIsAnomaly ? 'YES' : 'NO',
      'Risk_Score': risk,
      'Air_Fuel_Ratio': +derived.afr.toFixed(2),
      'Excess_Air_Pct': +derived.excessAir.toFixed(1),
      'Pressure_Margin_bar': +derived.pressureMargin.toFixed(2),
      'Boiler_Load_Pct': +derived.boilerLoad.toFixed(1),
    }]);
    XLSX.utils.book_append_sheet(wb, ws, 'Snapshot');
  }

  // Sheet 2: Telemetry_History — buffered performance series (up to 60 points)
  const effDs = state.performanceSeries.datasets[0];
  if (effDs.length > 0) {
    const divDs0 = state.divergenceSeries.datasets[0];
    const divDs1 = state.divergenceSeries.datasets[1];
    const rows = effDs.map((_, i) => ({
      'Sequence': i + 1,
      'Efficiency_Pct': state.performanceSeries.datasets[0][i],
      'Tube_Health_Pct': state.performanceSeries.datasets[1][i],
      'Heat_Rate_kJ_kg': state.performanceSeries.datasets[2][i],
      'Steam_Temp_C': divDs0[i] ?? null,
      'Flue_Gas_Temp_C': divDs1[i] ?? null,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, 'Telemetry_History');
  }

  // Sheet 3: Alerts — recent alert events (up to 20)
  if (state.alerts.length > 0) {
    const rows = state.alerts.map(a => ({
      'Timestamp': a.timestamp,
      'Severity': a.severity,
      'Message': a.message,
      'Tag': a.tag,
      'Value': a.value,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, 'Alerts');
  }

  // Sheet 4: Anomaly_Scores — time-series anomaly readings (up to 60 points)
  const anomDs = state.anomalySeries.datasets[0];
  if (anomDs.length > 0) {
    const rows = anomDs.map((score, i) => ({
      'Sequence': i + 1,
      'Anomaly_Score_Pct': score,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, 'Anomaly_Scores');
  }

  // Sheet 5: Forecast — Moirai probabilistic bands
  if (state.moiraiForecast) {
    const f = state.moiraiForecast;
    const rows: Record<string, string | number>[] = [];
    const metrics = ['tube_health', 'efficiency', 'steam_pressure'] as const;
    for (const metric of metrics) {
      const m = f.metrics[metric];
      if (!m) continue;
      const len = m.p50.length;
      for (let i = 0; i < len; i++) {
        rows.push({
          'Metric': metric,
          'Step': i + 1,
          'P10': m.p10[i],
          'P50_Median': m.p50[i],
          'P90': m.p90[i],
        });
      }
    }
    if (rows.length > 0) {
      const ws = XLSX.utils.json_to_sheet(rows);
      XLSX.utils.book_append_sheet(wb, ws, 'Forecast');
    }
  }

  // Sheet 6: Scatter_Data — fuel flow vs steam flow (up to 50 points)
  if (state.scatterData.length > 0) {
    const rows = state.scatterData.map((p, i) => ({
      'Sequence': i + 1,
      'Fuel_Flow_m3_hr': p.x,
      'Steam_Flow_kg_hr': p.y,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, 'Scatter_Data');
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  XLSX.writeFile(wb, `nexus_export_${ts}.xlsx`);
}
