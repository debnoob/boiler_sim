"""
NEXUS OS — Environment Model
============================
Slowly-varying ambient conditions and fuel quality that a real boiler is exposed
to. A real boiler's performance drifts with the weather and the gas supply; this
layer injects that so efficiency / flue-gas / feedwater-temp respond to the
environment instead of being constant.

Design:
  * Parameters are STORED on the model and ADJUSTABLE at runtime (env vars at
    startup, or live via the MQTT control bus -> engine.environment.set_params()).
  * update(tick) advances a slow daily cycle + small noise and returns the current
    ambient temperature (C), relative humidity (%), and fuel LHV (MJ/m3).
  * The engine publishes these as telemetry tags, so dashboard graphs/metrics
    move when the environment changes.
"""

from __future__ import annotations

import math
import os

import numpy as np


def _envf(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


class EnvironmentModel:
    # Reference/nominal conditions the boiler was tuned at (baseline = no penalty).
    REF_AMBIENT_C = 25.0
    REF_FUEL_LHV  = 35.5   # MJ/m3 natural gas

    def __init__(self):
        # ── Adjustable parameters (stored) ──────────────────────────────────
        self.ambient_temp_mean      = _envf("ENV_AMBIENT_TEMP",     25.0)  # C
        self.ambient_temp_amplitude = _envf("ENV_AMBIENT_SWING",     6.0)  # +/- C daily swing
        self.humidity_mean          = _envf("ENV_HUMIDITY",         55.0)  # % RH
        self.fuel_lhv_mean          = _envf("ENV_FUEL_LHV",         35.5)  # MJ/m3
        self.fuel_lhv_variation     = _envf("ENV_FUEL_LHV_VAR",      0.8)  # +/- MJ/m3 slow drift
        self.day_period_s           = _envf("ENV_DAY_PERIOD_S",    600.0)  # sim "day" length (s)

        # ── Current values (updated each tick) ──────────────────────────────
        self.ambient_temp = self.ambient_temp_mean
        self.humidity     = self.humidity_mean
        self.fuel_lhv     = self.fuel_lhv_mean

    # Live adjustment — any subset of the parameter names above.
    def set_params(self, **kwargs) -> None:
        for key, value in kwargs.items():
            if value is None or not hasattr(self, key):
                continue
            # Only allow the adjustable parameters, not the live readings.
            if key in ("ambient_temp", "humidity", "fuel_lhv"):
                continue
            try:
                setattr(self, key, float(value))
            except (TypeError, ValueError):
                pass

    def update(self, tick: int):
        # Daily cycle: coldest before dawn, warmest mid-afternoon.
        phase = 2.0 * math.pi * (tick / max(self.day_period_s, 1.0))

        self.ambient_temp = (
            self.ambient_temp_mean
            - self.ambient_temp_amplitude * math.cos(phase)
            + np.random.normal(0, 0.15)
        )
        # Humidity loosely tracks opposite to temperature.
        self.humidity = min(100.0, max(5.0,
            self.humidity_mean + 10.0 * math.cos(phase) + np.random.normal(0, 0.5)))
        # Fuel quality drifts slowly on its own cycle (pipeline gas composition).
        self.fuel_lhv = (
            self.fuel_lhv_mean
            + self.fuel_lhv_variation * math.sin(0.5 * phase + 1.0)
            + np.random.normal(0, 0.03)
        )
        return self.ambient_temp, self.humidity, self.fuel_lhv

    def snapshot(self) -> dict:
        """Current readings + the adjustable parameter set (for the dashboard)."""
        return {
            "ambient_temp": round(self.ambient_temp, 2),
            "humidity":     round(self.humidity, 1),
            "fuel_lhv":     round(self.fuel_lhv, 3),
            "params": {
                "ambient_temp_mean":      self.ambient_temp_mean,
                "ambient_temp_amplitude": self.ambient_temp_amplitude,
                "humidity_mean":          self.humidity_mean,
                "fuel_lhv_mean":          self.fuel_lhv_mean,
                "fuel_lhv_variation":     self.fuel_lhv_variation,
                "day_period_s":           self.day_period_s,
            },
        }
