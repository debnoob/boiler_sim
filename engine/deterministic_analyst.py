"""
NEXUS OS — Deterministic Analyst Layer
=======================================
Pure-Python physics reasoning engine that runs BEFORE the LLM.

Pipeline:
    raw telemetry samples
        → DeviationScorer      (which sensors are off and by how much)
        → TrendAnalyser        (slope / acceleration per sensor, cross-correlations)
        → RootCauseClassifier  (named fault hypothesis + confidence)
        → PIDTuningDetector    (hunting / windup / offset in each control loop)
        → PhysicsBrief         (compact, pre-diagnosed struct)
        → format_brief_for_llm() → prompt string injected into LLM call

The LLM receives a concise verdict, not a raw sensor dump.  Its job becomes
narrating and nuancing a pre-decided diagnosis — eliminating generic answers
and dramatically reducing prompt size (and therefore inference latency).
"""

from __future__ import annotations

import math
import statistics
from dataclasses import dataclass, field
from typing import List, Optional

# ============================================================
# BASELINES  (mirror of ai_analyst.py so this module is standalone)
# ============================================================
BASELINES: dict[str, float] = {
    "steam_pressure":   10.0,
    "steam_temperature":180.0,
    "steam_flow":       2300.0,
    "drum_level":       400.0,
    "feedwater_flow":   2300.0,
    "feedwater_temp":   95.0,
    "fuel_flow":        138.0,
    "air_flow":         1518.0,
    "o2_percent":       3.2,
    "flue_gas_temp":    198.0,
    "tube_health":      97.0,
    "efficiency":       87.0,
}

# Per-sensor noise / variability sigma (pct of baseline) — deviations inside
# this band are noise, not signal.
NOISE_BAND: dict[str, float] = {
    "steam_pressure":    0.03,
    "steam_temperature": 0.02,
    "steam_flow":        0.04,
    "drum_level":        0.04,
    "feedwater_flow":    0.04,
    "feedwater_temp":    0.02,
    "fuel_flow":         0.04,
    "air_flow":          0.04,
    "o2_percent":        0.08,   # noisier transducer
    "flue_gas_temp":     0.03,
    "tube_health":       0.01,
    "efficiency":        0.02,
}

THRESHOLDS: dict[str, tuple[Optional[float], Optional[float]]] = {
    # sensor: (low_trip, high_trip)  — None means no limit on that side
    "steam_pressure":    (None,  13.0),
    "drum_level":        (280.0, None),
    "flue_gas_temp":     (None,  240.0),
    "o2_percent":        (2.0,   5.5),
    "tube_health":       (70.0,  None),
    "efficiency":        (60.0,  None),
}

# Stoichiometric air-fuel ratio for natural gas
STOICH_AFR = 11.0

# ============================================================
# DATACLASSES
# ============================================================

@dataclass
class SensorDeviation:
    sensor:            str
    value:             float
    baseline:          float
    delta:             float          # absolute
    delta_pct:         float          # percent of baseline
    direction:         str            # "HIGH" | "LOW"
    severity:          str            # "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"
    breached_threshold:bool

    def __str__(self) -> str:
        sign = "+" if self.delta >= 0 else ""
        thresh = " ⚠ THRESHOLD BREACHED" if self.breached_threshold else ""
        return (
            f"{self.sensor}: {self.value:.2f}  "
            f"({sign}{self.delta_pct:.1f}% vs {self.baseline:.1f} baseline)"
            f"  [{self.severity}]{thresh}"
        )


@dataclass
class SensorTrend:
    sensor:  str
    slope:   float         # units/s — positive = rising
    accel:   float         # slope change per sample — positive = accelerating up
    n:       int           # sample count used

    def label(self) -> str:
        if abs(self.slope) < 1e-4:
            return "STABLE"
        direction = "↑ RISING" if self.slope > 0 else "↓ FALLING"
        rate = abs(self.slope)
        # Express nicely with units/s
        return f"{direction} {rate:.3g}/s"


@dataclass
class TuningIssue:
    loop:               str   # "pressure" | "drum_level" | "combustion_o2"
    symptom:            str   # human-readable observation
    diagnosis:          str   # which gain is at fault
    recommended_action: str   # specific step for the operator / engineer


@dataclass
class PhysicsBrief:
    primary_hypothesis:   str
    confidence:           str                       # "HIGH" | "MEDIUM" | "LOW"
    hypothesis_label:     str                       # human-readable title
    deviating_sensors:    List[SensorDeviation]
    trends:               dict[str, SensorTrend]   # sensor → trend
    trend_summary:        str                       # compact one-liner
    cross_correlations:   List[str]
    pid_issues:           List[TuningIssue]
    corrective_actions:   List[str]
    efficiency_chain:     Optional[str]             # pre-built efficiency narrative
    raw_snapshot:         dict                      # latest tag values


# ============================================================
# CORRECTIVE ACTIONS  (deterministic, physics-grounded)
# ============================================================
HYPOTHESIS_LABELS: dict[str, str] = {
    "tube_fouling":           "Tube Fouling / Heat-Transfer Degradation",
    "excess_air_combustion":  "Excess Air — Combustion Inefficiency",
    "incomplete_combustion":  "Incomplete Combustion / Rich Mixture",
    "feedwater_starvation":   "Feedwater Starvation — Low Drum Level",
    "pid_hunting_pressure":   "Pressure PID Hunting — Control Loop Instability",
    "pid_hunting_drum":       "Drum Level PID Hunting — Feedwater Loop Instability",
    "steam_demand_drop":      "Steam Demand Reduction — Load Decrease",
    "flame_failure_esd":      "Flame Failure / Emergency Shutdown",
    "air_damper_fault":       "Air Damper Fault — Combustion Air Restriction",
    "feedwater_valve_fault":  "Feedwater Valve Fault — Flow Restriction",
    "sensor_drift":           "Sensor Drift — Level Bias Suspected",
    "general_degradation":    "General Performance Degradation",
    "normal_operation":       "Normal Operation — No Fault Detected",
}

CORRECTIVE_ACTIONS: dict[str, list[str]] = {
    "tube_fouling": [
        "Initiate soot-blowing sequence immediately to reduce surface deposits",
        "Reduce firing rate by 10–15% to limit thermal stress while fouling is active",
        "Lower O₂ setpoint to 2.8% to trim excess-air heat losses and recover efficiency",
        "Monitor flue-gas temperature: if it exceeds 240°C, reduce load further or trip",
        "Schedule chemical tube cleaning at the next maintenance window",
    ],
    "excess_air_combustion": [
        "Close air damper 5–8% to bring O₂ into the optimal 2–4% band",
        "Verify combustion air-fuel ratio — target stoichiometric 11:1",
        "Check O₂ analyser calibration: stale span gas can cause persistent over-reading",
        "Once O₂ normalises, confirm flue-gas temp drops toward 198°C baseline",
    ],
    "incomplete_combustion": [
        "CRITICAL: Open air damper immediately to bring O₂ above 2% — CO risk",
        "Reduce fuel flow to re-establish safe combustion stoichiometry",
        "Inspect burner tips for partial blockage causing rich mixture",
        "Do NOT increase load until O₂ stabilises above 2% for at least 60 seconds",
    ],
    "feedwater_starvation": [
        "Increase feedwater pump speed / open feedwater valve to maximum safe rate",
        "Check drum level PID setpoint — it may have drifted from 400 mm",
        "Verify feedwater valve is not partially closed (check actuator feedback)",
        "If drum level < 200 mm: trip the boiler — dry-fire tube-rupture risk",
        "Check feedwater supply pressure — low header pressure limits maximum flow",
    ],
    "pid_hunting_pressure": [
        "Reduce pressure PID integral gain (Ki) by 20–30% to stop oscillation",
        "If pressure swings exceed ±1 bar: switch controller to manual until retuned",
        "Verify steam demand is stable — external load swings can mask hunting",
        "After gain reduction, allow 5 minutes for the loop to settle",
    ],
    "pid_hunting_drum": [
        "Reduce drum level PID derivative gain (Kd) by 20% to eliminate derivative kick",
        "If feedwater and level are oscillating antiphase: Kd is too high, reduce first",
        "If level drifts monotonically with no correction: Kp is too low — increase 10%",
        "Check feedwater actuator response time — sluggish valve amplifies hunting",
    ],
    "steam_demand_drop": [
        "Verify process steam demand: check downstream header pressure and flow meters",
        "If load reduction is deliberate, reduce pressure setpoint to lower firing rate",
        "Monitor safety valve — high pressure + low demand risks lifting at 13.5 bar",
        "Normal: no corrective action needed. Abnormal: investigate downstream process",
    ],
    "flame_failure_esd": [
        "IMMEDIATE: All steam and fuel isolation valves must be verified CLOSED",
        "Purge the furnace per your site ESD procedure before any restart attempt",
        "Check igniter, UV flame scanner, and fuel supply pressure before re-light",
        "Inspect fuel valve for leakage — no restart until furnace is confirmed safe",
        "Complete incident report before returning the boiler to service",
    ],
    "air_damper_fault": [
        "Check air damper actuator position feedback against commanded position",
        "Manually verify damper blade is not mechanically stuck or seized",
        "O₂ will be abnormally low — fire on manual with reduced fuel until fixed",
        "Do NOT increase load with a restricted air damper — CO and soot risk",
    ],
    "feedwater_valve_fault": [
        "Bypass feedwater control valve and operate manual isolation valve",
        "Check valve actuator for air supply / signal loss",
        "Maintain drum level above 280 mm minimum — reduce load if level falls",
        "Repair or replace actuator before returning to automatic drum level control",
    ],
    "sensor_drift": [
        "Compare level gauge glass reading against MQTT drum_level value",
        "If gauge and MQTT differ by >20 mm: suspect level sensor bias — do not trust auto control",
        "Operate drum level in manual mode based on gauge glass reading",
        "Calibrate or replace level transmitter at the earliest opportunity",
    ],
    "general_degradation": [
        "Review trend: if efficiency has fallen >5% from baseline, schedule inspection",
        "Compare fuel consumption vs steam output to quantify heat-rate penalty",
        "Check all sensor calibration certificates — gradual drift can appear as degradation",
        "Initiate a planned maintenance inspection within 48 hours",
    ],
    "normal_operation": [
        "No corrective action required",
        "Continue monitoring — all sensors within normal operating bands",
    ],
}


# ============================================================
# 1. DEVIATION SCORER
# ============================================================
def _severity_label(delta_pct: float, breached: bool) -> str:
    if breached:
        return "CRITICAL" if abs(delta_pct) > 20 else "HIGH"
    if abs(delta_pct) > 15:
        return "HIGH"
    if abs(delta_pct) > 8:
        return "MEDIUM"
    return "LOW"


def score_deviations(tags: dict) -> list[SensorDeviation]:
    """
    Compare every sensor in *tags* against BASELINES.
    Returns a list sorted by |delta_pct| descending — most anomalous first.
    Sensors within their noise band are excluded.
    """
    results: list[SensorDeviation] = []
    for sensor, baseline in BASELINES.items():
        value = tags.get(sensor)
        if value is None:
            continue
        delta = value - baseline
        delta_pct = (delta / baseline) * 100 if baseline != 0 else 0.0
        noise_pct = NOISE_BAND.get(sensor, 0.03) * 100
        if abs(delta_pct) <= noise_pct:
            continue  # within noise — not a deviation

        # Threshold breach check
        lo, hi = THRESHOLDS.get(sensor, (None, None))
        breached = (
            (hi is not None and value > hi) or
            (lo is not None and value < lo)
        )
        direction = "HIGH" if delta > 0 else "LOW"
        results.append(SensorDeviation(
            sensor=sensor,
            value=round(value, 3),
            baseline=baseline,
            delta=round(delta, 3),
            delta_pct=round(delta_pct, 1),
            direction=direction,
            severity=_severity_label(delta_pct, breached),
            breached_threshold=breached,
        ))

    results.sort(key=lambda d: abs(d.delta_pct), reverse=True)
    return results


# ============================================================
# 2. TREND ANALYSER
# ============================================================
def _linear_slope(values: list[float]) -> tuple[float, float]:
    """
    Ordinary-least-squares slope and a crude acceleration estimate.
    Returns (slope_per_sample, accel) where accel is the difference
    between the slope of the second half vs the first half.
    """
    n = len(values)
    if n < 4:
        return 0.0, 0.0
    x_mean = (n - 1) / 2.0
    y_mean = statistics.mean(values)
    num = sum((i - x_mean) * (v - y_mean) for i, v in enumerate(values))
    den = sum((i - x_mean) ** 2 for i in range(n))
    slope = num / den if den > 0 else 0.0

    mid = n // 2
    slope_first = _linear_slope(values[:mid])[0]
    slope_second = _linear_slope(values[mid:])[0]
    accel = slope_second - slope_first
    return slope, accel


def analyse_trends(samples: list[dict]) -> dict[str, SensorTrend]:
    """
    Run a linear regression over the last N samples for every sensor.
    Returns a dict mapping sensor name → SensorTrend.
    """
    # Build per-sensor time series
    series: dict[str, list[float]] = {s: [] for s in BASELINES}
    for reading in samples:
        tags = reading.get("tags", {})
        for sensor in BASELINES:
            v = tags.get(sensor)
            if v is not None:
                series[sensor].append(float(v))

    trends: dict[str, SensorTrend] = {}
    for sensor, vals in series.items():
        if len(vals) < 4:
            continue
        slope, accel = _linear_slope(vals)
        trends[sensor] = SensorTrend(sensor=sensor, slope=round(slope, 5),
                                     accel=round(accel, 5), n=len(vals))
    return trends


def build_trend_summary(trends: dict[str, SensorTrend]) -> str:
    """One-line human-readable trend overview of the most significant movements."""
    movers = sorted(
        [(s, t) for s, t in trends.items() if abs(t.slope) > 0.001],
        key=lambda x: abs(x[1].slope), reverse=True
    )[:5]
    if not movers:
        return "All sensors stable."
    parts = [f"{s} {t.label()}" for s, t in movers]
    return " | ".join(parts)


# ============================================================
# 3. ROOT-CAUSE CLASSIFIER
# ============================================================
def classify_root_cause(
    tags: dict,
    deviations: list[SensorDeviation],
    trends: dict[str, SensorTrend],
) -> tuple[str, str, list[str]]:
    """
    Pure decision-tree root-cause classification — no ML, no LLM.

    Returns:
        (hypothesis_key, confidence, cross_correlations)
    """
    dev_map = {d.sensor: d for d in deviations}
    trend_map = trends

    def rising(sensor: str, threshold: float = 0.01) -> bool:
        t = trend_map.get(sensor)
        return t is not None and t.slope > threshold

    def falling(sensor: str, threshold: float = -0.01) -> bool:
        t = trend_map.get(sensor)
        return t is not None and t.slope < threshold

    def above_baseline(sensor: str, pct: float = 5) -> bool:
        d = dev_map.get(sensor)
        return d is not None and d.direction == "HIGH" and abs(d.delta_pct) >= pct

    def below_baseline(sensor: str, pct: float = 5) -> bool:
        d = dev_map.get(sensor)
        return d is not None and d.direction == "LOW" and abs(d.delta_pct) >= pct

    fgt   = tags.get("flue_gas_temp", 198.0)
    th    = tags.get("tube_health", 97.0)
    o2    = tags.get("o2_percent", 3.2)
    eff   = tags.get("efficiency", 87.0)
    drum  = tags.get("drum_level", 400.0)
    flame = tags.get("flame_status", 1)
    fuel  = tags.get("fuel_flow", 138.0)
    fw    = tags.get("feedwater_flow", 2300.0)
    press = tags.get("steam_pressure", 10.0)

    correlations: list[str] = []

    # ── Flame failure — highest priority ──────────────────────────────────
    if flame == 0:
        correlations.append("Flame status = OFF — combustion has ceased")
        if o2 > 18.0:
            correlations.append(f"O₂ = {o2:.1f}% (atmospheric) confirms no combustion")
        return "flame_failure_esd", "HIGH", correlations

    # ── Tube fouling ───────────────────────────────────────────────────────
    # Three signal paths (ordered by certainty):
    #   A) Full signature: FGT high + tube health low + efficiency low → HIGH
    #   B) Two-sensor: FGT high + tube health low (efficiency may not have
    #      propagated yet at early degradation stage) → MEDIUM
    #   C) Trend-only: FGT rising AND tube health falling, even if still
    #      within noise band — early warning → LOW
    fgt_hi     = above_baseline("flue_gas_temp", pct=6)
    fgt_mild   = above_baseline("flue_gas_temp", pct=3)   # early-stage
    th_low     = below_baseline("tube_health", pct=3)
    th_mild    = below_baseline("tube_health", pct=1.5)   # early-stage
    eff_low    = below_baseline("efficiency", pct=4)
    eff_mild   = below_baseline("efficiency", pct=2)
    fgt_rising = rising("flue_gas_temp", 0.05)
    th_falling = falling("tube_health", -0.005)

    # Path A — full confirmed signature
    fouling_full = fgt_hi and th_low and (eff_low or eff_mild)
    # Path B — two strong sensors (efficiency lag is normal early on)
    fouling_partial = fgt_hi and th_low
    # Path C — trend-based early warning
    fouling_trend = fgt_mild and th_mild and fgt_rising and th_falling

    if fouling_full or fouling_partial or fouling_trend:
        correlations.append(
            f"FGT {fgt:.1f}°C rising while tube health {th:.1f}% falls — "
            "confirms heat-transfer degradation from tube fouling"
        )
        if fuel > BASELINES["fuel_flow"] * 1.05:
            correlations.append(
                f"Fuel flow {fuel:.1f} m³/hr (+{(fuel/BASELINES['fuel_flow']-1)*100:.0f}% "
                "above baseline) while steam output unchanged — wasted energy confirms fouling"
            )
        if fgt_rising and th_falling:
            correlations.append(
                "FGT trend accelerating upward AND tube health trend accelerating downward — "
                "progressive fouling, not a transient"
            )
        if fouling_trend and not (fouling_full or fouling_partial):
            correlations.append(
                "EARLY WARNING: sensors still within threshold bands but trending toward fouling signature — "
                "pre-emptive action recommended"
            )
        if fouling_full:
            confidence = "HIGH" if (fgt > 220 or th < 85) else "MEDIUM"
        elif fouling_partial:
            confidence = "MEDIUM"
        else:
            confidence = "LOW"
        return "tube_fouling", confidence, correlations

    # ── Incomplete combustion / rich mixture ───────────────────────────────
    if o2 < 2.0:
        correlations.append(
            f"O₂ = {o2:.2f}% BELOW 2% minimum — incomplete combustion, CO risk"
        )
        if fuel > BASELINES["fuel_flow"] * 1.1:
            correlations.append(
                f"Fuel flow {fuel:.1f} m³/hr elevated — rich mixture confirms"
            )
        return "incomplete_combustion", "HIGH", correlations

    # ── Excess air ────────────────────────────────────────────────────────
    if o2 > 5.5 and eff_low:
        correlations.append(
            f"O₂ = {o2:.2f}% ABOVE 5.5% — excess air is the primary efficiency driver"
        )
        air_fuel = tags.get("air_flow", 1518.0) / max(fuel, 0.01)
        if air_fuel > STOICH_AFR * 1.15:
            correlations.append(
                f"Air-fuel ratio = {air_fuel:.1f} (stoich = {STOICH_AFR:.0f}) — "
                "too much air is diluting combustion gases and raising stack losses"
            )
        return "excess_air_combustion", "HIGH", correlations

    if o2 > 4.0 and eff_low:
        correlations.append(
            f"O₂ = {o2:.2f}% — slightly above optimal band (2–4%)"
        )
        return "excess_air_combustion", "MEDIUM", correlations

    # ── Feedwater starvation ──────────────────────────────────────────────
    if drum < 280.0:
        correlations.append(
            f"Drum level {drum:.1f} mm BELOW 280 mm low alarm threshold"
        )
        if fw < BASELINES["feedwater_flow"] * 0.85:
            correlations.append(
                f"Feedwater flow {fw:.1f} kg/hr = only "
                f"{fw/BASELINES['feedwater_flow']*100:.0f}% of demand — valve restriction?"
            )
        if falling("drum_level", -0.5):
            correlations.append("Drum level trend is still FALLING — risk escalating")
        confidence = "HIGH" if drum < 250 else "MEDIUM"
        return "feedwater_starvation", confidence, correlations

    # ── Air damper fault (O2 abnormally low, not from rich mixture) ───────
    if o2 < 1.5 and fuel > 50:
        correlations.append(
            f"O₂ = {o2:.2f}% despite active combustion — air supply may be restricted"
        )
        return "air_damper_fault", "MEDIUM", correlations

    # ── Steam demand drop (pressure rising, load reducing) ─────────────────
    if above_baseline("steam_pressure", pct=10) and rising("steam_pressure"):
        correlations.append(
            f"Steam pressure {press:.2f} bar rising above {BASELINES['steam_pressure']} bar "
            "setpoint — steam demand has likely dropped"
        )
        return "steam_demand_drop", "MEDIUM", correlations

    # ── Feedwater valve fault (level normal but flow abnormally low) ───────
    if fw < BASELINES["feedwater_flow"] * 0.7 and drum > 300:
        correlations.append(
            f"Feedwater flow {fw:.1f} kg/hr ({fw/BASELINES['feedwater_flow']*100:.0f}% of "
            "demand) yet drum level is holding — valve may be in bypass"
        )
        return "feedwater_valve_fault", "MEDIUM", correlations

    # ── Sensor drift (efficiency low but nothing else explains it) ─────────
    dev_sensors = {d.sensor for d in deviations}
    if eff_low and "drum_level" not in dev_sensors and "flue_gas_temp" not in dev_sensors and o2 < 5.0:
        correlations.append(
            f"Efficiency {eff:.1f}% below baseline with no clear sensor root cause — "
            "possible gradual sensor drift or unmodelled loss"
        )
        return "general_degradation", "LOW", correlations

    # ── General degradation ────────────────────────────────────────────────
    if eff_low or th_low:
        correlations.append(
            f"Efficiency {eff:.1f}% / tube health {th:.1f}% below normal — "
            "progressive degradation without a single dominant cause"
        )
        return "general_degradation", "LOW", correlations

    return "normal_operation", "HIGH", ["All monitored sensors within normal operating bands"]


# ============================================================
# 4. PID TUNING ISSUE DETECTOR
# ============================================================
# Sampling rate = 1 Hz, so window sizes are in seconds.

def _oscillation_period_and_amp(values: list[float]) -> tuple[float, float]:
    """
    Detect the dominant oscillation period (s) and amplitude in a signal.
    Uses a simple zero-crossing approach — accurate enough for slow industrial loops.
    Returns (period, amplitude) or (0.0, 0.0) if no oscillation detected.
    """
    if len(values) < 6:
        return 0.0, 0.0
    mean = statistics.mean(values)
    centred = [v - mean for v in values]
    # Find zero crossings
    crossings = [i for i in range(1, len(centred)) if centred[i-1] * centred[i] < 0]
    if len(crossings) < 2:
        return 0.0, 0.0
    half_periods = [crossings[i+1] - crossings[i] for i in range(len(crossings)-1)]
    period = 2.0 * statistics.mean(half_periods)  # full period estimate
    amplitude = (max(values) - min(values)) / 2.0
    return round(period, 1), round(amplitude, 3)


def detect_pid_issues(samples: list[dict]) -> list[TuningIssue]:
    """
    Analyse the last N samples for control-loop stability problems.

    Three loops checked:
      1. Pressure loop  (steam_pressure vs setpoint → fuel_flow)
      2. Drum level loop (drum_level → feedwater_flow)
      3. Combustion O₂  (o2_percent → air_flow)
    """
    if len(samples) < 12:
        return []

    issues: list[TuningIssue] = []

    # Extract time series
    def ts(sensor: str) -> list[float]:
        return [
            float(s["tags"][sensor])
            for s in samples
            if sensor in s.get("tags", {})
        ]

    pressures    = ts("steam_pressure")
    drum_levels  = ts("drum_level")
    fw_flows     = ts("feedwater_flow")
    o2_pct       = ts("o2_percent")

    # ── 1. Pressure PID ───────────────────────────────────────────────────
    if len(pressures) >= 12:
        period, amp = _oscillation_period_and_amp(pressures[-20:])
        mean_p = statistics.mean(pressures)
        std_p  = statistics.pstdev(pressures)

        if amp > 0.5 and period < 25:
            issues.append(TuningIssue(
                loop="pressure",
                symptom=(
                    f"Steam pressure oscillating ±{amp:.2f} bar with a {period:.0f}s period "
                    f"(mean={mean_p:.2f} bar)"
                ),
                diagnosis="Integral gain (Ki) too high — causing integral windup oscillation",
                recommended_action=(
                    "Reduce pressure PID Ki by 20–30% (current Ki=0.1 in boiler_engine.py). "
                    "Switch to manual mode if pressure swings exceed ±1.0 bar until retuned."
                ),
            ))
        elif std_p > 0.3 and mean_p > BASELINES["steam_pressure"] * 1.1:
            issues.append(TuningIssue(
                loop="pressure",
                symptom=(
                    f"Sustained pressure offset: mean {mean_p:.2f} bar "
                    f"vs {BASELINES['steam_pressure']} bar setpoint (std={std_p:.2f})"
                ),
                diagnosis="Proportional gain (Kp) insufficient or integral not accumulating correctly",
                recommended_action=(
                    "Increase pressure PID Kp from 2.0 to 2.5, "
                    "or verify the integral term is not clamped."
                ),
            ))

    # ── 2. Drum Level PID ─────────────────────────────────────────────────
    if len(drum_levels) >= 12 and len(fw_flows) >= 12:
        period_l, amp_l = _oscillation_period_and_amp(drum_levels[-20:])
        period_f, amp_f = _oscillation_period_and_amp(fw_flows[-20:])
        mean_l = statistics.mean(drum_levels)
        std_l  = statistics.pstdev(drum_levels)

        antiphase = (
            period_l > 0 and period_f > 0 and
            abs(period_l - period_f) < 3 and
            amp_l > 8 and amp_f > 100
        )
        if antiphase:
            issues.append(TuningIssue(
                loop="drum_level",
                symptom=(
                    f"Drum level and feedwater flow oscillating antiphase — "
                    f"level amp={amp_l:.1f}mm / {period_l:.0f}s, "
                    f"feedwater amp={amp_f:.0f} kg/hr / {period_f:.0f}s"
                ),
                diagnosis=(
                    "Derivative gain (Kd) too high — derivative kick amplifying oscillation "
                    "through the feedwater actuator"
                ),
                recommended_action=(
                    "Reduce drum level PID Kd from 1.0 to 0.5–0.7 (boiler_engine.py). "
                    "Check feedwater valve actuator lag — a slow actuator worsens antiphase oscillation."
                ),
            ))
        elif abs(mean_l - 400.0) > 30 and std_l < 10:
            # Steady offset — not enough proportional authority
            issues.append(TuningIssue(
                loop="drum_level",
                symptom=(
                    f"Drum level holding at {mean_l:.1f} mm "
                    f"(setpoint 400 mm, offset {mean_l-400:.1f} mm) with no correction trend"
                ),
                diagnosis="Proportional gain (Kp) too low — steady-state error not being eliminated",
                recommended_action=(
                    "Increase drum level PID Kp from 5.0 to 6.5. "
                    "Alternatively verify the Ki term accumulates — zero Ki gives permanent offset."
                ),
            ))

    # ── 3. Combustion O₂ PID ─────────────────────────────────────────────
    if len(o2_pct) >= 12:
        period_o, amp_o = _oscillation_period_and_amp(o2_pct[-20:])
        mean_o = statistics.mean(o2_pct)
        std_o  = statistics.pstdev(o2_pct)

        if amp_o > 0.4 and period_o < 30:
            issues.append(TuningIssue(
                loop="combustion_o2",
                symptom=(
                    f"O₂ hunting ±{amp_o:.2f}% with a {period_o:.0f}s period "
                    f"at mean {mean_o:.2f}% — trim loop unstable"
                ),
                diagnosis=(
                    "Integral gain (Ki) too aggressive for the slow O₂ analyser response — "
                    "common cause is analyser cell lag not accounted for in loop tuning"
                ),
                recommended_action=(
                    "Reduce combustion O₂ PID Ki from 0.2 to 0.12–0.15. "
                    "Add 4–6 s derivative filter time-constant to smooth analyser signal before "
                    "feeding the derivative term."
                ),
            ))
        elif std_o > 0.5 and mean_o > BASELINES["o2_percent"] * 1.3:
            issues.append(TuningIssue(
                loop="combustion_o2",
                symptom=(
                    f"O₂ persistently high: mean {mean_o:.2f}% vs {BASELINES['o2_percent']}% "
                    f"setpoint (std={std_o:.2f}%)"
                ),
                diagnosis=(
                    "Air damper minimum position may be too high, or O₂ setpoint has not "
                    "been updated after load reduction"
                ),
                recommended_action=(
                    "Check air damper actuator minimum stop position. "
                    "Verify O₂ setpoint is 3.2% — adjust if load has changed significantly."
                ),
            ))

    return issues


# ============================================================
# 5. EFFICIENCY CHAIN NARRATIVE
# ============================================================
def compute_efficiency_losses(tags: dict) -> dict:
    """
    Deterministic heat-loss split from live tags. Single source of truth for the
    diagnosis narrative and the operator-facing 'where am I losing efficiency'
    chat answer, so both quote identical numbers. Mirrors calculate_efficiency in
    boiler_engine.py. Components are returned unranked; the caller sorts them.
    """
    eff   = tags.get("efficiency", BASELINES["efficiency"])
    fgt   = tags.get("flue_gas_temp", BASELINES["flue_gas_temp"])
    o2    = tags.get("o2_percent", BASELINES["o2_percent"])
    th    = tags.get("tube_health", BASELINES["tube_health"])
    fuel  = tags.get("fuel_flow", BASELINES["fuel_flow"])
    steam = tags.get("steam_flow", BASELINES["steam_flow"])

    stack_loss      = max(0.0, (fgt - 150.0) * 0.04)
    excess_air_loss = max(0.0, (o2 - 3.0) * 0.8)
    ua_factor       = th / 97.0  # approximate from tube health
    fouling_loss    = max(0.0, (1.0 - ua_factor) * 15.0)
    total_loss      = stack_loss + excess_air_loss + fouling_loss
    heat_rate       = (fuel * 35.5 * 1000.0) / max(steam, 1.0)  # kJ/kg approx

    return {
        "efficiency": eff,
        "baseline": BASELINES["efficiency"],
        "total_loss": total_loss,
        "heat_rate": heat_rate,
        "components": [
            {
                "name": "Stack heat loss",
                "pct": stack_loss,
                "driver": f"flue-gas temp {fgt:.1f}C vs 198C baseline",
                "lever": "Recover stack heat: check economizer, soot-blowing, and firing rate.",
            },
            {
                "name": "Excess-air loss",
                "pct": excess_air_loss,
                "driver": f"O2 {o2:.2f}% vs the 3.0% optimal",
                "lever": "Trim combustion air toward ~3% O2 to cut excess-air loss.",
            },
            {
                "name": "Tube-fouling loss",
                "pct": fouling_loss,
                "driver": f"tube health {th:.1f}%",
                "lever": "Schedule tube cleaning/inspection to restore heat transfer.",
            },
        ],
    }


def build_efficiency_narrative(tags: dict, deviations: list[SensorDeviation]) -> Optional[str]:
    """
    Build a concise efficiency chain explanation from deterministic values.
    Only emitted when efficiency is outside its noise band.
    """
    eff = tags.get("efficiency", BASELINES["efficiency"])
    if abs(eff - BASELINES["efficiency"]) < 3.0:
        return None

    fgt    = tags.get("flue_gas_temp", BASELINES["flue_gas_temp"])
    o2     = tags.get("o2_percent", BASELINES["o2_percent"])
    th     = tags.get("tube_health", BASELINES["tube_health"])
    fuel   = tags.get("fuel_flow", BASELINES["fuel_flow"])
    steam  = tags.get("steam_flow", BASELINES["steam_flow"])

    # Compute individual loss contributions (mirrors calculate_efficiency in boiler_engine.py)
    stack_loss       = max(0, (fgt - 150) * 0.04)
    excess_air_loss  = max(0, (o2 - 3.0) * 0.8)
    ua_factor        = th / 97.0  # approximate from tube health
    fouling_loss     = (1.0 - ua_factor) * 15.0
    total_loss       = stack_loss + excess_air_loss + fouling_loss
    heat_rate        = (fuel * 35.5 * 1000) / max(steam, 1.0)  # kJ/kg approx

    lines = [
        f"Efficiency is {eff:.1f}% (baseline {BASELINES['efficiency']}%, loss = {BASELINES['efficiency']-eff:.1f}%).",
        f"Loss breakdown:",
        f"  Stack heat loss:   {stack_loss:.1f}%  (FGT={fgt:.1f}°C, baseline 198°C)",
        f"  Excess air loss:   {excess_air_loss:.1f}%  (O₂={o2:.2f}%, optimal ≤3.0%)",
        f"  Tube fouling loss: {fouling_loss:.1f}%  (tube health={th:.1f}%)",
        f"  Total accounted:   {total_loss:.1f}%",
        f"Effective heat rate: {heat_rate:.0f} kJ/kg (lower is better, ~10 500 at baseline)",
    ]
    return "\n".join(lines)


# ============================================================
# 6. TOP-LEVEL BUILDER
# ============================================================
def build_physics_brief(samples: list[dict]) -> PhysicsBrief:
    """
    Main entry point.  Call with the last N readings from TelemetryBuffer.

    Args:
        samples: list of heartbeat payloads, most-recent last.

    Returns:
        PhysicsBrief — the complete pre-diagnosis struct ready for the LLM.
    """
    if not samples:
        return PhysicsBrief(
            primary_hypothesis="normal_operation",
            confidence="LOW",
            hypothesis_label="Insufficient Data",
            deviating_sensors=[],
            trends={},
            trend_summary="No telemetry data available.",
            cross_correlations=[],
            pid_issues=[],
            corrective_actions=["Wait for telemetry warm-up period to complete."],
            efficiency_chain=None,
            raw_snapshot={},
        )

    latest = samples[-1]
    tags   = latest.get("tags", {})

    deviations  = score_deviations(tags)
    trends      = analyse_trends(samples)
    hypothesis, confidence, correlations = classify_root_cause(tags, deviations, trends)
    pid_issues  = detect_pid_issues(samples)
    eff_chain   = build_efficiency_narrative(tags, deviations)
    trend_summ  = build_trend_summary(trends)
    actions     = list(CORRECTIVE_ACTIONS.get(hypothesis, ["Review telemetry manually."]))

    # If PID issues detected, prepend a PID-specific action to the list
    if pid_issues:
        for pi in pid_issues:
            actions.insert(0, f"[{pi.loop.upper()} PID] {pi.recommended_action}")

    return PhysicsBrief(
        primary_hypothesis=hypothesis,
        confidence=confidence,
        hypothesis_label=HYPOTHESIS_LABELS.get(hypothesis, hypothesis),
        deviating_sensors=deviations,
        trends=trends,
        trend_summary=trend_summ,
        cross_correlations=correlations,
        pid_issues=pid_issues,
        corrective_actions=actions,
        efficiency_chain=eff_chain,
        raw_snapshot=tags,
    )


# ============================================================
# 7. LLM PROMPT FORMATTER
# ============================================================
def format_brief_for_llm(brief: PhysicsBrief, context: str = "diagnosis") -> str:
    """
    Serialize a PhysicsBrief into the compact prompt block that replaces raw telemetry.

    context: "diagnosis"  — for anomaly/alert incident cards
             "chat"       — for operator Q&A (efficiency narrative injected)
             "efficiency" — chat question specifically about efficiency
    """
    lines: list[str] = []

    lines.append("══ DETERMINISTIC PRE-ANALYSIS — DO NOT SECOND-GUESS THESE FINDINGS ══")
    lines.append("")
    lines.append(
        f"PRIMARY HYPOTHESIS: {brief.hypothesis_label}  [{brief.confidence} confidence]"
    )
    lines.append("")

    # Deviating sensors — top 6 max to keep prompts tight
    if brief.deviating_sensors:
        lines.append("DEVIATING SENSORS (ranked by severity):")
        for i, d in enumerate(brief.deviating_sensors[:6], 1):
            trend = brief.trends.get(d.sensor)
            trend_str = f"  {trend.label()}" if trend else ""
            thresh_str = "  ⚠ THRESHOLD BREACHED" if d.breached_threshold else ""
            lines.append(
                f"  {i}. {d.sensor}: {d.value:.2f}  "
                f"({'+' if d.delta >= 0 else ''}{d.delta_pct:.1f}% vs {d.baseline} baseline)"
                f"{trend_str}{thresh_str}"
            )
    else:
        lines.append("DEVIATING SENSORS: None — all within normal bands")

    lines.append("")
    lines.append(f"SENSOR TRENDS: {brief.trend_summary}")
    lines.append("")

    # Cross-sensor correlations
    if brief.cross_correlations:
        lines.append("CROSS-SENSOR CORRELATIONS (physics-verified):")
        for c in brief.cross_correlations:
            lines.append(f"  • {c}")
    lines.append("")

    # Efficiency chain (always for efficiency context, optional for others)
    if brief.efficiency_chain and context in ("efficiency", "chat"):
        lines.append("EFFICIENCY LOSS CHAIN:")
        for el in brief.efficiency_chain.splitlines():
            lines.append(f"  {el}")
        lines.append("")

    # PID tuning issues
    if brief.pid_issues:
        lines.append("CONTROL LOOP TUNING ISSUES DETECTED:")
        for pi in brief.pid_issues:
            lines.append(f"  [{pi.loop.upper()} LOOP] {pi.symptom}")
            lines.append(f"    Diagnosis: {pi.diagnosis}")
            lines.append(f"    Fix: {pi.recommended_action}")
        lines.append("")

    # Pre-selected corrective actions
    if brief.corrective_actions:
        lines.append("PRE-SELECTED CORRECTIVE ACTIONS (confirm, prioritise, and explain timing):")
        for i, a in enumerate(brief.corrective_actions[:5], 1):
            lines.append(f"  {i}. {a}")
    lines.append("")

    # Instruction to LLM
    if context == "diagnosis":
        lines.append(
            "Your task: Write a concise incident diagnosis explaining WHY these findings point "
            f"to '{brief.hypothesis_label}'. Prioritise the corrective actions above based on "
            "current severity and timing. Do NOT invent new sensor readings or hypotheses. "
            "Be direct and actionable — this is an industrial operations audience."
        )
    elif context in ("chat", "efficiency"):
        lines.append(
            "Your task: Answer the operator's question using ONLY the pre-computed findings "
            "above. Reference specific sensor values and the loss breakdown provided. "
            "Do not provide generic boiler theory — cite the actual numbers. "
            "Keep the response under 180 words. Use bullet lists for recommendations."
        )

    lines.append("══════════════════════════════════════════════════════════════════════")
    return "\n".join(lines)
