export interface TelemetryTags {
  steam_pressure: number;
  steam_temperature: number;
  steam_flow: number;
  drum_level: number;
  feedwater_flow: number;
  feedwater_temp: number;
  fuel_flow: number;
  air_flow: number;
  o2_percent: number;
  flue_gas_temp: number;
  tube_health: number;
  efficiency: number;
  heat_rate: number;
  flame_status: number;
  safety_valve: number;
  // Environment (ambient + fuel quality) — present when the engine env layer is on
  ambient_temp?: number;
  humidity?: number;
  fuel_lhv?: number;
}

export interface EnvironmentState {
  ambient_temp: number;
  humidity: number;
  fuel_lhv: number;
  params: {
    ambient_temp_mean: number;
    ambient_temp_amplitude: number;
    humidity_mean: number;
    fuel_lhv_mean: number;
    fuel_lhv_variation: number;
    day_period_s: number;
  };
}

export interface ControlState {
  autopilot: boolean;
  o2_setpoint: number;
  pressure_setpoint: number;
  degradation_rate_factor: number;
  firing_reduction_pct: number;
  soot_blows: number;
}

export interface HeartbeatPayload {
  timestamp: number;
  tags: TelemetryTags;
  degradation_factor: number;
  mode: string;
  control?: ControlState;
}

export interface ControlActionPayload {
  type: 'control_action';
  headline: string;
  timestamp: string;
  setpoints: { o2_percent: number; steam_pressure_bar: number };
  firing_reduction_pct: number;
  degradation_slope_reduction_pct: number;
  soot_blow: boolean;
  reason: string;
  before: { flue_gas_temp: number; tube_health: number; efficiency: number; fuel_flow: number };
  commands: string[];
}

export interface AnomalyPayload {
  score: number;
  is_anomaly: boolean;
  timestamp: number;
}

export interface AlertPayload {
  severity: 'CRITICAL' | 'HIGH' | 'WARNING' | 'LOW';
  message: string;
  tag: string;
  value: number;
  threshold: number;
  timestamp: string;
}

export interface DeviatedSensor {
  sensor: string;
  tag?: string;
  value: number | string;
  baseline?: number | string;
  severity: string;
}

export interface DiagnosisPayload {
  type?: string;
  probable_cause?: string;
  severity: string;
  explanation?: string;
  recommended_action?: string | any;
  confidence?: number;
  pattern_note?: string | null;
  deviated_sensors?: DeviatedSensor[];
  flagged_assets?: Array<{ name: string; severity: string; detail: string }>;
}

export interface MaintenancePriority {
  rank: number;
  task: string;
  when: string;
  discipline: string;
  severity: string;
  impact?: string;
  detail?: string;
  evidence?: string[];
}

export interface AiResponsePayload {
  type?: 'shift_report' | 'what_if' | 'chat' | 'maintenance_priorities';
  answer?: string;
  response?: string;
  summary?: string;
  uptime_pct?: number;
  anomaly_events?: number;
  alerts?: Record<string, number>;
  efficiency?: { start?: number; end?: number };
  overall_status?: string;
  highlights?: string[];
  follow_ups?: string[];
  shift_duration?: string;
  shift_label?: string;
  shift_start?: string;
  shift_end?: string;
  data_source?: string;
  fact_contract?: Record<string, unknown>;
  interpretation_contract?: Record<string, unknown>;
  validation_issues?: string[];
  scenario?: string;
  risk_level?: string;
  steps?: Array<{ step?: number; event?: string; consequence?: string }>;
  operator_actions?: string[];
  // Maintenance-priority card
  priorities?: MaintenancePriority[];
  window?: string;
  samples_7d?: number;
  samples_30d?: number;
  note?: string;
}

export interface OeeSnapshotPayload {
  type?: 'oee_update' | 'oee_shift';
  timestamp: number;
  shift_label?: string;
  shift_start?: string;
  shift_end?: string;
  shift_duration?: string;
  data_source?: string;
  empty?: boolean;
  uptime_pct?: number;
  anomaly_events?: number;
  alerts?: Record<string, number>;
  efficiency?: { start?: number; end?: number; min?: number; max?: number };
  modes_seen?: string[];
  status_timeline?: Array<{ state: 'production' | 'slow' | 'downtime' | 'critical' | 'setup' | string; start: number; end: number }>;
  oee?: {
    availability?: number;
    performance?: number;
    quality?: number;
    oee?: number;
    planned_seconds?: number;
    available_seconds?: number;
    avg_efficiency_pct?: number;
    rated_efficiency_pct?: number;
    load_utilization?: number;
    actual_steam_kg?: number;
    available_steam_kg?: number;
    rated_steam_kg?: number;
    good_steam_kg?: number;
    rated_steam_flow_kg_hr?: number;
  };
}

export interface OeeHistoryPayload {
  type: 'oee_history';
  timestamp: number;
  current_shift_label?: string;
  shifts: OeeSnapshotPayload[];
}

export interface StreamMessage {
  id: string;
  text: string;
  color: 'emerald' | 'amber' | 'red';
  timestamp: string;
}

export interface AlertEvent {
  id: string;
  severity: 'CRITICAL' | 'HIGH' | 'WARNING' | 'LOW';
  message: string;
  tag: string;
  value: number;
  timestamp: string;
}

export type ChatMessageType = 'ai' | 'user' | 'thinking' | 'diagnosis' | 'shift_report' | 'what_if' | 'maintenance_priorities';

export interface ChatMessage {
  id: string;
  type: ChatMessageType;
  content: string;
  timestamp: string;
  data?: DiagnosisPayload | AiResponsePayload;
}

export interface HealthPoint {
  t: number;
  v: number;
}

// ── Moirai 2.0 Forecast ─────────────────────────────────────
export interface ForecastMetric {
  history: number[];
  p10: number[];
  p50: number[];
  p90: number[];
}

export interface MoiraiForecastPayload {
  timestamp: number;
  horizon_seconds: number;
  backend: string;
  metrics: {
    tube_health?: ForecastMetric;
    efficiency?: ForecastMetric;
    steam_pressure?: ForecastMetric;
  };
  projected_breach_eta: number | null; // seconds from now, or null
}

export type MqttConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';
export type AiStatus = 'online' | 'analyzing';
export type OperatingMode = 'NORMAL' | 'DEGRADING' | 'CRITICAL' | 'FAULT';

export interface InterventionEvent {
  heartbeatCountAtDetection: number;
  arrLengthAtDetection: number;
  timestamp: string;
  fuelFlowBefore: number;
  fuelFlowReduction: number;   // percent
  efficiencyAtEvent: number;
  flueGasTempAtEvent: number;
  tubeHealthAtEvent: number;
  label: string;
  forecastDeadlineAtDetection: number | null;  // seconds timestamp
}
