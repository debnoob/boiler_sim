'use client';

import { create } from 'zustand';
import { calcRisk } from './utils';
import type {
  TelemetryTags,
  StreamMessage,
  AlertEvent,
  ChatMessage,
  AnomalyPayload,
  DiagnosisPayload,
  AiResponsePayload,
  HealthPoint,
  MoiraiForecastPayload,
  MqttConnectionStatus,
  AiStatus,
  OperatingMode,
  InterventionEvent,
  ControlState,
  ControlActionPayload,
} from '@/types/telemetry';

const MAX_CHART_POINTS = 60;
const MAX_SCATTER_POINTS = 50;
const MAX_STREAM_MSGS = 30;
const MAX_ALERTS = 20;
const MAX_CHAT_MSGS = 25;
const MAX_HEALTH_HISTORY = 45;

interface ChartSeries {
  labels: string[];
  datasets: number[][];
}

interface ScatterPoint { x: number; y: number; }

export interface KpiBaseline {
  steam_pressure: number;
  drum_level: number;
  efficiency: number;
  tube_health: number;
}

function pushPoint(series: ChartSeries, values: number[]): ChartSeries {
  const labels = [...series.labels, ''];
  const datasets = series.datasets.map((ds, i) => [...ds, values[i] ?? 0]);
  if (labels.length > MAX_CHART_POINTS) {
    labels.shift();
    datasets.forEach(ds => ds.shift());
  }
  return { labels, datasets };
}

export interface NexusStore {
  // Connection
  mqttStatus: MqttConnectionStatus;
  msgCount: number;
  setMqttStatus: (s: MqttConnectionStatus) => void;

  // Telemetry
  tags: TelemetryTags | null;
  degradationFactor: number;
  mode: OperatingMode;
  anomalyScore: number;
  anomalyIsAnomaly: boolean;
  setHeartbeat: (tags: TelemetryTags, degradation: number, mode: string) => void;
  setAnomalyScore: (payload: AnomalyPayload) => void;
  setMode: (mode: string) => void;

  // Stream log
  streamMessages: StreamMessage[];
  addStream: (text: string, color?: 'emerald' | 'amber' | 'red') => void;

  // Alerts / timeline
  alerts: AlertEvent[];
  addAlert: (alert: AlertEvent) => void;
  acknowledgedAlertIds: string[];
  acknowledgeAlert: (id: string) => void;

  // Charts data
  performanceSeries: ChartSeries;   // [efficiency, tube_health, heat_rate]
  divergenceSeries: ChartSeries;    // [steam_temp, flue_gas_temp]
  anomalySeries: ChartSeries;       // [anomaly_score]
  fuelFlowSeries: ChartSeries;      // [fuel_flow]
  kpiSeries: ChartSeries;           // [steam_pressure, drum_level, efficiency, tube_health]
  kpiBaseline: KpiBaseline | null;  // first observed values, for session deltas
  riskSeries: ChartSeries;          // [failure_risk] — composite reliability risk over time
  scatterData: ScatterPoint[];

  // AI intervention tracking
  heartbeatCount: number;
  interventionEvents: InterventionEvent[];
  replayMode: boolean;
  setReplayMode: (active: boolean) => void;

  // Closed-loop control (real, from engine + AI analyst)
  controlState: ControlState | null;
  controlActions: ControlActionPayload[];
  setControlState: (c: ControlState) => void;
  addControlAction: (a: ControlActionPayload) => void;

  // Degradation forecaster
  healthHistory: HealthPoint[];
  forecastDeadline: number | null;

  // Moirai 2.0 probabilistic forecast
  moiraiForecast: MoiraiForecastPayload | null;
  setMoiraiForecast: (payload: MoiraiForecastPayload) => void;

  // AI chat
  aiStatus: AiStatus;
  chatMessages: ChatMessage[];
  woCount: number;
  setAiStatus: (s: AiStatus) => void;
  addChatMessage: (msg: ChatMessage) => void;
  removeChatMessage: (id: string) => void;
  setDiagnosis: (data: DiagnosisPayload) => void;
  setAiResponse: (data: AiResponsePayload) => void;

  // Theme
  isLight: boolean;
  toggleTheme: () => void;
}

export const useNexusStore = create<NexusStore>((set, get) => ({
  mqttStatus: 'connecting',
  msgCount: 0,
  setMqttStatus: (s) => set({ mqttStatus: s }),

  tags: null,
  degradationFactor: 0,
  mode: 'NORMAL',
  anomalyScore: 0,
  anomalyIsAnomaly: false,

  setHeartbeat: (tags, degradation, mode) => {
    const state = get();
    const now = Date.now() / 1000;

    const perfSeries = pushPoint(state.performanceSeries, [tags.efficiency, tags.tube_health, tags.heat_rate]);
    const divSeries = pushPoint(state.divergenceSeries, [tags.steam_temperature, tags.flue_gas_temp]);
    const fuelFlowSeries = pushPoint(state.fuelFlowSeries, [tags.fuel_flow]);
    const kpiSeries = pushPoint(state.kpiSeries, [tags.steam_pressure, tags.drum_level, tags.efficiency, tags.tube_health]);
    const riskSeries = pushPoint(state.riskSeries, [calcRisk(tags, degradation)]);
    const kpiBaseline = state.kpiBaseline ?? {
      steam_pressure: tags.steam_pressure,
      drum_level: tags.drum_level,
      efficiency: tags.efficiency,
      tube_health: tags.tube_health,
    };

    const newScatter: ScatterPoint[] = [...state.scatterData, { x: tags.fuel_flow, y: tags.steam_flow }];
    if (newScatter.length > MAX_SCATTER_POINTS) newScatter.shift();

    let healthHistory = [...state.healthHistory, { t: now, v: tags.tube_health }];
    if (healthHistory.length > MAX_HEALTH_HISTORY) healthHistory.shift();

    let forecastDeadline: number | null = null;
    if (tags.tube_health <= 70) {
      forecastDeadline = null;
    } else if (healthHistory.length >= 10) {
      const n = healthHistory.length;
      const t0 = healthHistory[0].t;
      let sx = 0, sy = 0, sxy = 0, sxx = 0;
      for (const p of healthHistory) {
        const x = p.t - t0;
        sx += x; sy += p.v; sxy += x * p.v; sxx += x * x;
      }
      const denom = n * sxx - sx * sx;
      const slope = denom !== 0 ? (n * sxy - sx * sy) / denom : 0;
      if (slope < -0.004) {
        const eta = (tags.tube_health - 70) / (-slope);
        forecastDeadline = now + eta;
      }
    }

    set({
      tags,
      degradationFactor: degradation,
      mode: (mode as OperatingMode) || 'NORMAL',
      msgCount: state.msgCount + 1,
      heartbeatCount: state.heartbeatCount + 1,
      performanceSeries: perfSeries,
      divergenceSeries: divSeries,
      fuelFlowSeries,
      kpiSeries,
      kpiBaseline,
      riskSeries,
      scatterData: newScatter,
      healthHistory,
      forecastDeadline,
    });
  },

  setAnomalyScore: (payload) => {
    const state = get();
    const anomalySeries = pushPoint(state.anomalySeries, [payload.score]);
    set({
      anomalyScore: payload.score,
      anomalyIsAnomaly: payload.is_anomaly,
      anomalySeries,
      msgCount: state.msgCount + 1,
    });
  },

  setMode: (mode) => set({ mode: (mode as OperatingMode) || 'NORMAL' }),

  streamMessages: [{ id: '0', text: 'Waiting for MQTT broker connection...', color: 'emerald', timestamp: '' }],
  addStream: (text, color = 'emerald') => {
    const ts = new Date().toLocaleTimeString();
    const msg: StreamMessage = { id: `${Date.now()}-${Math.random()}`, text, color, timestamp: ts };
    set((state) => {
      const messages = [...state.streamMessages, msg];
      while (messages.length > MAX_STREAM_MSGS) messages.shift();
      return { streamMessages: messages };
    });
  },

  alerts: [],
  addAlert: (alert) => {
    set((state) => {
      const alerts = [...state.alerts, alert];
      if (alerts.length > MAX_ALERTS) alerts.shift();
      return { alerts };
    });
  },
  acknowledgedAlertIds: [],
  acknowledgeAlert: (id) => {
    set((state) => (
      state.acknowledgedAlertIds.includes(id)
        ? state
        : { acknowledgedAlertIds: [...state.acknowledgedAlertIds, id] }
    ));
  },

  performanceSeries: { labels: [], datasets: [[], [], []] },
  divergenceSeries: { labels: [], datasets: [[], []] },
  anomalySeries: { labels: [], datasets: [[]] },
  fuelFlowSeries: { labels: [], datasets: [[]] },
  kpiSeries: { labels: [], datasets: [[], [], [], []] },
  kpiBaseline: null,
  riskSeries: { labels: [], datasets: [[]] },
  scatterData: [],
  healthHistory: [],
  forecastDeadline: null,

  heartbeatCount: 0,
  interventionEvents: [],
  replayMode: false,
  setReplayMode: (active) => set({ replayMode: active }),

  controlState: null,
  controlActions: [],
  setControlState: (c) => set({ controlState: c }),
  addControlAction: (a) => {
    const state = get();
    // Record the REAL intervention marker at the current chart position
    const before = a.before ?? { fuel_flow: 0, efficiency: 0, flue_gas_temp: 0 };
    const event: InterventionEvent = {
      heartbeatCountAtDetection: state.heartbeatCount,
      arrLengthAtDetection: state.divergenceSeries.labels.length,
      timestamp: a.timestamp,
      fuelFlowBefore: before.fuel_flow,
      fuelFlowReduction: a.firing_reduction_pct,
      efficiencyAtEvent: before.efficiency,
      flueGasTempAtEvent: before.flue_gas_temp,
      tubeHealthAtEvent: before.tube_health,
      label: `AI reduced firing ${a.firing_reduction_pct}% at ${a.timestamp} — degradation slope reduced ${a.degradation_slope_reduction_pct}%`,
      forecastDeadlineAtDetection: state.forecastDeadline,
    };
    const controlActions = [...state.controlActions, a];
    if (controlActions.length > 12) controlActions.shift();
    set({
      controlActions,
      interventionEvents: [...state.interventionEvents, event],
    });
  },

  moiraiForecast: null,
  setMoiraiForecast: (payload) => {
    // Prefer the Moirai-projected breach ETA over the linear regression estimate
    const moiraiForecastDeadline = payload.projected_breach_eta != null
      ? Date.now() / 1000 + payload.projected_breach_eta
      : null;
    set((state) => ({
      moiraiForecast: payload,
      // Only overwrite forecastDeadline if Moirai has a projection;
      // otherwise keep the linear regression value intact.
      forecastDeadline: moiraiForecastDeadline ?? state.forecastDeadline,
    }));
  },

  aiStatus: 'online',
  chatMessages: [{
    id: 'welcome',
    type: 'ai',
    content: 'Online and monitoring **BOILER-01** in real time via **MQTT**.\n\nI ingest live telemetry every second — **steam pressure**, **drum level**, **combustion efficiency**, and **tube health**. When an anomaly is detected, I auto-generate an **incident card** with a diagnosis and recommended action.\n\nUse the quick-prompt chips below, or ask me anything about the plant.',
    timestamp: 'System · Just now',
  }],
  woCount: 47820,

  setAiStatus: (s) => set({ aiStatus: s }),

  addChatMessage: (msg) => {
    set((state) => {
      const messages = [...state.chatMessages, msg];
      while (messages.length > MAX_CHAT_MSGS) messages.shift();
      return { chatMessages: messages };
    });
  },

  removeChatMessage: (id) => {
    set((state) => ({ chatMessages: state.chatMessages.filter(m => m.id !== id) }));
  },

  setDiagnosis: (data) => {
    const state = get();
    state.removeChatMessage('thinking');
    const woCount = state.woCount + 1;
    const msg: ChatMessage = {
      id: `diag-${Date.now()}`,
      type: data.type === 'asset_flags' ? 'diagnosis' : 'diagnosis',
      content: '',
      timestamp: new Date().toLocaleTimeString(),
      data,
    };
    set((s) => {
      const messages = [...s.chatMessages.filter(m => m.id !== 'thinking'), msg];
      while (messages.length > MAX_CHAT_MSGS) messages.shift();
      return { chatMessages: messages, woCount };
    });
  },

  setAiResponse: (data) => {
    set((state) => {
      const messages = state.chatMessages.filter(m => m.id !== 'thinking');
      const msg: ChatMessage = {
        id: `resp-${Date.now()}`,
        type: data.type === 'shift_report' ? 'shift_report'
          : data.type === 'what_if' ? 'what_if'
          : data.type === 'maintenance_priorities' ? 'maintenance_priorities'
          : 'ai',
        content: data.answer || data.response || '',
        timestamp: new Date().toLocaleTimeString(),
        data,
      };
      const next = [...messages, msg];
      while (next.length > MAX_CHAT_MSGS) next.shift();
      return { chatMessages: next };
    });
  },

  isLight: false,
  toggleTheme: () => {
    set((state) => {
      const next = !state.isLight;
      if (typeof document !== 'undefined') {
        document.body.classList.toggle('light', next);
        localStorage.setItem('nexus-theme', next ? 'light' : 'dark');
      }
      return { isLight: next };
    });
  },
}));
