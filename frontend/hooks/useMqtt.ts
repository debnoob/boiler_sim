'use client';

import { useEffect, useRef } from 'react';
import { useNexusStore } from '@/lib/store';
import type { HeartbeatPayload, AnomalyPayload, AlertPayload, DiagnosisPayload, AiResponsePayload, AlertEvent, MoiraiForecastPayload, ControlActionPayload } from '@/types/telemetry';

const MQTT_URL = 'ws://localhost:9001';
const TOPIC = 'factory/pumphouse4/boiler/#';
const ALERT_THROTTLE_MS = 3000;

export function useMqtt() {
  const clientRef = useRef<import('mqtt').MqttClient | null>(null);
  const lastAlertRef = useRef<number>(0);
  const store = useNexusStore();

  useEffect(() => {
    let destroyed = false;

    async function connect() {
      const mqttModule = await import('mqtt');
      if (destroyed) return;

      // Handle differences in ES module packaging (named vs default export)
      const connectFn = mqttModule.connect || (mqttModule as any).default?.connect;
      if (!connectFn) {
        throw new Error('MQTT connect function not found in imported module.');
      }

      const client = connectFn(MQTT_URL, {
        clientId: 'nexus_dashboard_' + Math.random().toString(16).substr(2, 8),
        reconnectPeriod: 2000,
      });
      clientRef.current = client;

      client.on('connect', () => {
        if (destroyed) return;
        store.setMqttStatus('connected');
        store.addStream('✓ Connected to Mosquitto broker on port 9001', 'emerald');
        client.subscribe(TOPIC, (err) => {
          if (!err) store.addStream('✓ Subscribed to factory/pumphouse4/boiler/#', 'emerald');
        });
      });

      client.on('error', (err) => {
        store.setMqttStatus('error');
        store.addStream('✗ MQTT Error: ' + err.message, 'red');
      });

      client.on('reconnect', () => {
        store.setMqttStatus('connecting');
        store.addStream('⟳ Attempting reconnect...', 'amber');
      });

      client.on('message', (topic: string, payload: Buffer) => {
        try {
          const raw = payload.toString();

          if (topic.endsWith('/heartbeat')) {
            const msg = JSON.parse(raw) as HeartbeatPayload;
            store.setHeartbeat(msg.tags, msg.degradation_factor, msg.mode);
            if (msg.control) store.setControlState(msg.control);
          } else if (topic.endsWith('/ai/control_action')) {
            const action = JSON.parse(raw) as ControlActionPayload;
            store.addControlAction(action);
            store.addStream(`🤖 AI Autopilot: ${action.headline}`, 'emerald');
          } else if (topic.endsWith('/alerts')) {
            const now = Date.now();
            if (now - lastAlertRef.current < ALERT_THROTTLE_MS) return;
            lastAlertRef.current = now;
            const a = JSON.parse(raw) as AlertPayload;
            store.addStream(
              `⚠ ${a.severity}: ${a.message}`,
              a.severity === 'CRITICAL' ? 'red' : a.severity === 'HIGH' ? 'amber' : 'amber',
            );
            const event: AlertEvent = {
              id: `${Date.now()}-${Math.random()}`,
              severity: a.severity,
              message: a.message,
              tag: a.tag,
              value: a.value,
              timestamp: a.timestamp || new Date().toISOString(),
            };
            store.addAlert(event);
          } else if (topic.endsWith('/mode')) {
            let parsedMode = raw;
            try {
              const modeObj = JSON.parse(raw);
              parsedMode = modeObj.mode || raw;
            } catch { /* raw is already the mode string */ }
            store.setMode(parsedMode);
            if (parsedMode !== 'NORMAL') store.addStream(`▶ Mode changed: ${parsedMode}`, 'amber');
          } else if (topic.endsWith('/anomaly_score')) {
            store.setAnomalyScore(JSON.parse(raw) as AnomalyPayload);
          } else if (topic.endsWith('/ai/diagnosis')) {
            store.setDiagnosis(JSON.parse(raw) as DiagnosisPayload);
          } else if (topic.endsWith('/ai/response')) {
            const data = JSON.parse(raw) as AiResponsePayload;
            // Derive a readable type: shift_report or what_if are structured; anything else is a plain chat answer
            const msgType = data.type === 'shift_report' ? 'shift_report'
              : data.type === 'what_if' ? 'what_if'
              : 'ai';
            store.addStream(
              `⬡ AI response received (${msgType})`,
              'emerald',
            );
            store.setAiResponse(data);
          } else if (topic.endsWith('/ai/status')) {
            const msg = JSON.parse(raw);
            store.setAiStatus(msg.status === 'analyzing' ? 'analyzing' : 'online');
          } else if (topic.endsWith('/ai/forecast')) {
            const msg = JSON.parse(raw) as MoiraiForecastPayload;
            store.setMoiraiForecast(msg);
          }
        } catch (e) {
          console.error('[useMqtt] parse error on', topic, e);
          if (topic.endsWith('/mode')) {
            store.setMode(payload.toString());
          }
        }
      });
    }

    connect();

    return () => {
      destroyed = true;
      clientRef.current?.end();
    };
  }, []);

  function publish(topic: string, payload: object) {
    clientRef.current?.publish(topic, JSON.stringify(payload));
  }

  return { publish };
}
