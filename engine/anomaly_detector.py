"""
NEXUS OS — ML Anomaly Detector
Subscribes to MQTT stream, runs Isolation Forest, publishes anomaly scores.
"""

import paho.mqtt.client as mqtt
import json
import numpy as np
from sklearn.ensemble import IsolationForest
from collections import deque
import time
import os

# MQTT Config
BROKER = os.environ.get("MQTT_BROKER_HOST", "localhost")
PORT = 1883
TOPIC_SUB = "factory/pumphouse4/boiler/unit01/heartbeat"
TOPIC_PUB = "factory/pumphouse4/boiler/unit01/ai/anomaly_score"

# ML Config
FEATURES = [
    "steam_pressure", "steam_temperature", "drum_level",
    "fuel_flow", "flue_gas_temp", "efficiency",
    "furnace_pressure_pa", "flue_gas_flow_kg_hr", "stack_damper_actual_pct",
    "feedwater_ph", "dissolved_oxygen", "tube_wall_thickness",
    "corrosion_rate", "tube_leak_flow",
]
WARMUP_SAMPLES = 40  # Collect this many normal samples before training
# IsolationForest.decision_function() is centered around the fitted model's
# contamination cutoff. With a small, tight 40-sample warm-up, real faults in
# this simulator typically score near 0.0 rather than below -0.1.
ANOMALY_THRESHOLD = 0.05
ANOMALY_SCORE_CEILING = 0.20

class AnomalyDetector:
    def __init__(self):
        self.model = IsolationForest(n_estimators=100, contamination=0.05, random_state=42)
        self.data_buffer = deque(maxlen=WARMUP_SAMPLES)
        self.is_trained = False
        self.mqtt_client = mqtt.Client(client_id="nexus_anomaly_detector")

    def on_connect(self, client, userdata, flags, rc):
        print(f"[ML Engine] Connected to broker.")
        client.subscribe(TOPIC_SUB)
        print(f"[ML Engine] Subscribed to {TOPIC_SUB}")
        print(f"[ML Engine] Warming up model... collecting {WARMUP_SAMPLES} normal samples.")

    def on_message(self, client, userdata, msg):
        try:
            payload = json.loads(msg.payload.decode())
            tags = payload.get("tags", {})
            
            # Do not turn a missing sensor into a fake zero. That would train a
            # false baseline or create an artificial anomaly.
            if any(f not in tags or not isinstance(tags[f], (int, float)) for f in FEATURES):
                print("[ML Engine] Skipping heartbeat with incomplete feature set")
                return
            features = [float(tags[f]) for f in FEATURES]

            # The first baseline must be healthy. If the detector starts during
            # a fault scenario, wait for NORMAL/IDEAL samples instead of
            # learning the fault as normal behavior.
            mode = str(payload.get("mode", "NORMAL")).upper()
            if not self.is_trained and mode not in {"NORMAL", "IDEAL"}:
                return

            self.data_buffer.append(features)

            if not self.is_trained:
                if len(self.data_buffer) == WARMUP_SAMPLES:
                    self.train_model()
                return

            # Predict anomaly
            score = self.model.decision_function([features])[0]
            is_anomaly = 1 if score < ANOMALY_THRESHOLD else 0
            
            # Publish a UI score where 0 is nominal and the detector threshold
            # maps to 100. Keep the raw model score for troubleshooting.
            anomaly_pct = int(np.clip(
                (ANOMALY_SCORE_CEILING - score)
                / (ANOMALY_SCORE_CEILING - ANOMALY_THRESHOLD) * 100,
                0, 100,
            ))
            
            payload_out = {
                "score": anomaly_pct,
                "is_anomaly": bool(is_anomaly),
                "decision_score": round(float(score), 5),
                "timestamp": time.time()
            }
            client.publish(TOPIC_PUB, json.dumps(payload_out))
            
            if is_anomaly:
                print(f"[ML Engine] ⚠️ ANOMALY DETECTED! Score: {anomaly_pct}%")

        except Exception as e:
            print(f"[ML Engine] Error: {e}")

    def train_model(self):
        print(f"[ML Engine] Training Isolation Forest on {WARMUP_SAMPLES} samples...")
        X = np.array(list(self.data_buffer))
        self.model.fit(X)
        self.is_trained = True
        print(f"[ML Engine] ✅ Model trained. Monitoring for anomalies.")

    def run(self):
        self.mqtt_client.on_connect = self.on_connect
        self.mqtt_client.on_message = self.on_message
        self.mqtt_client.connect(BROKER, PORT, 60)
        self.mqtt_client.loop_forever()

if __name__ == "__main__":
    detector = AnomalyDetector()
    detector.run()
