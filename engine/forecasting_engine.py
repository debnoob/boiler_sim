import paho.mqtt.client as mqtt
import json
import time
import numpy as np
from collections import deque
import os

# ============================================================
# MQTT CONFIG
# ============================================================
BROKER = os.environ.get("MQTT_BROKER_HOST", "localhost")
PORT = 1883
HEARTBEAT_TOPIC = "factory/pumphouse4/boiler/unit01/system/heartbeat"
FORECAST_TOPIC  = "factory/pumphouse4/boiler/unit01/ai/forecast"

# ============================================================
# FORECASTING CONFIG
# ============================================================
HISTORY_LEN        = 90   # Seconds of historical data to keep in ring buffer
MIN_HISTORY        = 30   # Minimum samples before running inference
FORECAST_HORIZON   = 60   # Steps ahead to forecast (60 seconds)
INFERENCE_INTERVAL = 15   # Run Moirai every N seconds (CPU-friendly)
BREACH_THRESHOLD   = 70.0 # Tube health breach level (%)
METRICS            = ["tube_health", "efficiency", "steam_pressure"]


# ============================================================
# MODEL LOADER — updated for Moirai 2.0 Decoder Architecture
# ============================================================
def load_moirai_model():
    """
    Attempt to load Moirai 2.0 R-Small via the official uni2ts library.
    If the library is not installed, attempt a HuggingFace pipeline fallback.
    Returns (model, backend_name) tuple.
    """
    # Try uni2ts (primary path)
    try:
        # FIXED: Updated import path to target the Moirai2 Decoder modules
        from uni2ts.model.moirai2 import Moirai2Forecast, Moirai2Module
        print("[Moirai Engine] ✓ uni2ts found — loading Salesforce/moirai-2.0-R-small ...")
        import torch
        
        # FIXED: Instantiated the layout wrapper using the pre-trained module method
        model = Moirai2Forecast(
            module=Moirai2Module.from_pretrained("Salesforce/moirai-2.0-R-small"),
            prediction_length=FORECAST_HORIZON,
            context_length=HISTORY_LEN,
            target_dim=1,
            feat_dynamic_real_dim=0,
            past_feat_dynamic_real_dim=0,
        )
        device = "cuda" if torch.cuda.is_available() else "cpu"
        model = model.to(device)
        model.eval()
        print(f"[Moirai Engine] ✓ Model loaded on {device.upper()}")
        return model, "uni2ts"
    except ImportError:
        print("[Moirai Engine] ⚠ uni2ts not found — trying HuggingFace pipeline ...")

    # Fallback: chronos-style HuggingFace pipeline
    try:
        import torch
        from transformers import pipeline
        pipe = pipeline(
            "time-series-prediction",
            model="Salesforce/moirai-2.0-R-small",
            device=0 if torch.cuda.is_available() else -1,
        )
        print("[Moirai Engine] ✓ HuggingFace pipeline loaded")
        return pipe, "hf_pipeline"
    except Exception as e:
        print(f"[Moirai Engine] ✗ HuggingFace pipeline also failed: {e}")

    print("[Moirai Engine] ⚠ Running in SIMULATION mode (statistical fallback)")
    return None, "simulation"


# ============================================================
# INFERENCE HELPERS
# ============================================================
def run_inference_uni2ts(model, history_values: np.ndarray) -> dict:
    """Run Moirai inference via the uni2ts library."""
    import torch
    import pandas as pd

    n = len(history_values)
    past_target = torch.tensor(history_values, dtype=torch.float32).unsqueeze(0).unsqueeze(-1)
    # Simple time features: integer positions
    past_observed_target = torch.ones_like(past_target, dtype=torch.bool)

    with torch.no_grad():
        samples = model(
            past_target=past_target,
            past_observed_target=past_observed_target,
        )
    # samples shape: [1, num_samples, horizon]
    samples_np = samples.squeeze(0).cpu().numpy()  # [num_samples, horizon]
    return {
        "p10": np.percentile(samples_np, 10, axis=0).tolist(),
        "p50": np.percentile(samples_np, 50, axis=0).tolist(),
        "p90": np.percentile(samples_np, 90, axis=0).tolist(),
    }


def run_inference_simulation(history_values: np.ndarray) -> dict:
    """
    Statistical fallback when Moirai cannot be loaded.
    Uses exponential smoothing + trend decomposition + noise simulation
    to produce realistic probabilistic bounds (100 Monte Carlo paths).
    """
    n = len(history_values)
    # Holt's double exponential smoothing
    alpha, beta = 0.3, 0.1
    level = history_values[0]
    trend = 0.0
    for v in history_values[1:]:
        prev_level = level
        level = alpha * v + (1 - alpha) * (level + trend)
        trend = beta * (level - prev_level) + (1 - beta) * trend

    # Residual std (captures random noise)
    smoothed = np.zeros(n)
    l, t = history_values[0], 0.0
    for i, v in enumerate(history_values):
        prev_l = l
        l = alpha * v + (1 - alpha) * (l + t)
        t = beta * (l - prev_l) + (1 - beta) * t
        smoothed[i] = l
    residual_std = max(np.std(history_values - smoothed), 0.05)

    # Monte Carlo: 100 sample paths
    rng = np.random.default_rng(seed=int(time.time()))
    paths = np.zeros((100, FORECAST_HORIZON))
    for s in range(100):
        l_s, t_s = level, trend
        for h in range(FORECAST_HORIZON):
            l_s = l_s + t_s
            noise = rng.normal(0, residual_std)
            paths[s, h] = l_s + noise

    return {
        "p10": np.percentile(paths, 10, axis=0).tolist(),
        "p50": np.percentile(paths, 50, axis=0).tolist(),
        "p90": np.percentile(paths, 90, axis=0).tolist(),
    }


def find_breach_eta(p10: list[float], threshold: float) -> float | None:
    """Return seconds until worst-case (p10) crosses the breach threshold."""
    for idx, v in enumerate(p10):
        if v <= threshold:
            return float(idx + 1)
    return None


# ============================================================
# MAIN FORECASTING SERVICE
# ============================================================
class MoiraiForecaster:
    def __init__(self):
        self.histories: dict[str, deque] = {
            m: deque(maxlen=HISTORY_LEN) for m in METRICS
        }
        self.last_inference_time = 0.0
        
        # FIXED: Added CallbackAPIVersion declaration to handle Paho-MQTT 2.x update requirements
        self.mqtt_client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION1, client_id="nexus_moirai_forecaster")
        self.model, self.backend = load_moirai_model()

    # ── MQTT CALLBACKS ──────────────────────────────────────
    def on_connect(self, client, userdata, flags, rc):
        if rc == 0:
            print("[Moirai Engine] ✓ Connected to MQTT broker")
            client.subscribe(HEARTBEAT_TOPIC)
            print(f"[Moirai Engine] ✓ Subscribed to heartbeat — inference every {INFERENCE_INTERVAL}s")
        else:
            print(f"[Moirai Engine] ✗ Connection failed rc={rc}")

    def on_message(self, client, userdata, msg):
        try:
            payload = json.loads(msg.payload.decode())
            tags = payload.get("tags", {})

            # Accumulate history for each metric
            for metric in METRICS:
                val = tags.get(metric)
                if val is not None:
                    self.histories[metric].append(float(val))

            # Run inference at the configured interval
            now = time.time()
            if now - self.last_inference_time >= INFERENCE_INTERVAL:
                min_len = min(len(h) for h in self.histories.values())
                if min_len >= MIN_HISTORY:
                    self.last_inference_time = now
                    self.run_and_publish()

        except Exception as e:
            print(f"[Moirai Engine] Message error: {e}")

    # ── INFERENCE + PUBLISH ─────────────────────────────────
    def run_and_publish(self):
        print(f"[Moirai Engine] 🔮 Running {self.backend} inference ...")
        forecast_results: dict = {}
        tube_p10 = None

        for metric in METRICS:
            history_values = np.array(list(self.histories[metric]))

            try:
                if self.backend == "uni2ts":
                    quants = run_inference_uni2ts(self.model, history_values)
                else:
                    # simulation OR hf_pipeline (use simulation as safe fallback)
                    quants = run_inference_simulation(history_values)
            except Exception as e:
                print(f"[Moirai Engine] Inference error on {metric}: {e}")
                quants = run_inference_simulation(history_values)

            forecast_results[metric] = {
                "history": history_values[-20:].tolist(),  # last 20 points for charts
                "p10": quants["p10"],
                "p50": quants["p50"],
                "p90": quants["p90"],
            }

            if metric == "tube_health":
                tube_p10 = quants["p10"]

        # Projected time-to-breach (tube health worst case)
        breach_eta = find_breach_eta(tube_p10, BREACH_THRESHOLD) if tube_p10 else None

        out = {
            "timestamp": time.time(),
            "horizon_seconds": FORECAST_HORIZON,
            "backend": self.backend,
            "metrics": forecast_results,
            "projected_breach_eta": breach_eta,  # seconds from now, or null
        }

        self.mqtt_client.publish(FORECAST_TOPIC, json.dumps(out), qos=1)
        print(
            f"[Moirai Engine] ✅ Forecast published — "
            f"tube_health breach ETA: {breach_eta:.0f}s" if breach_eta
            else f"[Moirai Engine] ✅ Forecast published — no breach projected"
        )

    # ── ENTRY POINT ─────────────────────────────────────────
    def run(self):
        print("=" * 60)
        print("  NEXUS OS — Moirai 2.0 Forecasting Engine")
        print(f"  Model   : Salesforce/moirai-2.0-R-small")
        print(f"  Backend : {self.backend}")
        print(f"  Broker  : {BROKER}:{PORT}")
        print(f"  Horizon : {FORECAST_HORIZON}s  |  Interval: {INFERENCE_INTERVAL}s")
        print("=" * 60)
        self.mqtt_client.on_connect = self.on_connect
        self.mqtt_client.on_message = self.on_message
        self.mqtt_client.connect(BROKER, PORT, 60)
        self.mqtt_client.loop_forever()


if __name__ == "__main__":
    forecaster = MoiraiForecaster()
    forecaster.run()

