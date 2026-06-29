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

# MQTT Config
BROKER = "localhost"
PORT = 1883
TOPIC_SUB = "factory/pumphouse4/boiler/unit01/heartbeat"
TOPIC_PUB = "factory/pumphouse4/boiler/unit01/ai/anomaly_score"

# ML Config
FEATURES = [
    "steam_pressure", "steam_temperature", "drum_level", 
    "fuel_flow", "flue_gas_temp", "efficiency"
]
WARMUP_SAMPLES = 40  # Collect this many normal samples before training
ANOMALY_THRESHOLD = -0.1  # Score below this is flagged as anomaly

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
            
            # Extract features
            features = [tags.get(f, 0) for f in FEATURES]
            self.data_buffer.append(features)

            if not self.is_trained:
                if len(self.data_buffer) == WARMUP_SAMPLES:
                    self.train_model()
                return

            # Predict anomaly
            score = self.model.decision_function([features])[0]
            is_anomaly = 1 if score < ANOMALY_THRESHOLD else 0
            
            # Publish score (0 to 100, where 100 is highly anomalous)
            # Invert and scale the score for UI
            anomaly_pct = max(0, min(100, int((1 - score) * 50)))
            
            payload_out = {
                "score": anomaly_pct,
                "is_anomaly": bool(is_anomaly),
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