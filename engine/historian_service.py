"""
NEXUS OS - Local historian ingest service.

Run this alongside the boiler engine:
    python engine/historian_service.py

It subscribes to the MQTT Unified Namespace and stores 90+ days of raw boiler
telemetry plus operational events in a local SQLite database.
"""

from __future__ import annotations

import json
import os
import time
from typing import Any

import paho.mqtt.client as mqtt

from historian_client import (
    default_db_path,
    init_db,
    insert_event,
    insert_heartbeat,
    prune_old_data,
)


BROKER = os.environ.get("MQTT_BROKER_HOST", "localhost")
PORT = int(os.environ.get("MQTT_BROKER_PORT", "1883"))
RETENTION_DAYS = int(os.environ.get("HISTORIAN_RETENTION_DAYS", "92"))

BASE_TOPIC = "factory/pumphouse4/boiler/unit01"
TOPIC_HEARTBEAT = f"{BASE_TOPIC}/system/heartbeat"
TOPIC_ALERTS = f"{BASE_TOPIC}/alerts"
TOPIC_ANOMALY = f"{BASE_TOPIC}/ai/anomaly_score"
TOPIC_DIAGNOSIS = f"{BASE_TOPIC}/ai/diagnosis"
TOPIC_CONTROL_ACTION = f"{BASE_TOPIC}/ai/control_action"
TOPIC_STATUS = f"{BASE_TOPIC}/historian/status"


EVENT_TOPICS = {
    TOPIC_ALERTS: "alert",
    TOPIC_ANOMALY: "anomaly_score",
    TOPIC_DIAGNOSIS: "diagnosis",
    TOPIC_CONTROL_ACTION: "control_action",
}


class HistorianService:
    def __init__(self):
        self.client = mqtt.Client(client_id="nexus_historian")
        self.samples_written = 0
        self.events_written = 0
        self.last_prune = 0.0
        self.db_path = default_db_path()
        init_db(self.db_path)

    def on_connect(self, client, userdata, flags, rc):
        if rc != 0:
            print(f"[Historian] MQTT connection failed rc={rc}")
            return
        print(f"[Historian] Connected to MQTT broker {BROKER}:{PORT}")
        print(f"[Historian] SQLite database: {self.db_path}")
        client.subscribe(TOPIC_HEARTBEAT, qos=1)
        for topic in EVENT_TOPICS:
            client.subscribe(topic, qos=1)
        self.publish_status("online")

    def on_disconnect(self, client, userdata, rc):
        print(f"[Historian] Disconnected from MQTT broker rc={rc}")

    def on_message(self, client, userdata, msg):
        try:
            payload = json.loads(msg.payload.decode())
            if not isinstance(payload, dict):
                return
            if msg.topic == TOPIC_HEARTBEAT:
                self.handle_heartbeat(payload)
            elif msg.topic in EVENT_TOPICS:
                self.handle_event(EVENT_TOPICS[msg.topic], payload, msg.topic)
        except Exception as exc:
            print(f"[Historian] Message error on {msg.topic}: {exc}")
            self.publish_status("error", error=str(exc))

    def handle_heartbeat(self, payload: dict[str, Any]) -> None:
        insert_heartbeat(payload, self.db_path)
        self.samples_written += 1
        now = time.time()
        if now - self.last_prune > 3600:
            prune_old_data(self.db_path, RETENTION_DAYS)
            self.last_prune = now
        if self.samples_written == 1 or self.samples_written % 60 == 0:
            self.publish_status("online")
            print(f"[Historian] Stored {self.samples_written} heartbeat samples")

    def handle_event(self, event_type: str, payload: dict[str, Any], topic: str) -> None:
        insert_event(event_type, payload, self.db_path, topic=topic)
        self.events_written += 1
        if self.events_written == 1 or self.events_written % 10 == 0:
            self.publish_status("online")
            print(f"[Historian] Stored {self.events_written} events")

    def publish_status(self, status: str, **extra: Any) -> None:
        body = {
            "status": status,
            "db_path": self.db_path,
            "samples_written": self.samples_written,
            "events_written": self.events_written,
            "retention_days": RETENTION_DAYS,
            "timestamp": time.time(),
            **extra,
        }
        self.client.publish(TOPIC_STATUS, json.dumps(body), qos=1, retain=True)

    def run(self):
        print("=" * 60)
        print("  NEXUS OS - Local Historian Service")
        print(f"  Broker : {BROKER}:{PORT}")
        print(f"  DB     : {self.db_path}")
        print(f"  Keep   : {RETENTION_DAYS} days raw telemetry")
        print("=" * 60)

        self.client.on_connect = self.on_connect
        self.client.on_disconnect = self.on_disconnect
        self.client.on_message = self.on_message
        self.client.connect(BROKER, PORT, 60)
        self.client.loop_forever()


if __name__ == "__main__":
    HistorianService().run()
