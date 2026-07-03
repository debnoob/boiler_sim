"""
NEXUS OS — AI Analyst Service
Connects to local Ollama server.

Ollama usage:
    export OLLAMA_MODEL=llama3.2:3b    # or any model you have pulled
    python engine/ai_analyst.py
"""

import paho.mqtt.client as mqtt
import json
import os
import re
import time
import uuid
import requests
from collections import deque
from datetime import datetime, timedelta
from threading import Lock
from dotenv import load_dotenv
load_dotenv()

# Deterministic pre-analysis layer — must import after load_dotenv
from deterministic_analyst import (
    build_physics_brief,
    format_brief_for_llm,
    HYPOTHESIS_LABELS,
)
from safety_policy import (
    build_safety_context,
    format_safety_context_for_prompt,
    validate_diagnosis_payload,
    validate_llm_text,
)

try:
    from historian_client import (
        answer_historical_metric_question,
        answer_maintenance_priority_question,
        build_historian_context,
        fetch_telemetry_window,
        count_events_window,
    )
except Exception:
    answer_historical_metric_question = None
    answer_maintenance_priority_question = None
    build_historian_context = None
    fetch_telemetry_window = None
    count_events_window = None

# ============================================================
# MANUAL KNOWLEDGE (in-prompt, keyword-routed — no vector DB)
# ============================================================
# STATIC_CORE is baked into the chat system prompt (cache-friendly, ~0 latency
# after warmup). route_manual() pulls only the 1-2 relevant sections per question.
from manual_sections import STATIC_CORE, route_manual

# ============================================================
# RAG CONFIG (DISABLED — kept for later; swap route_manual() back to rag_retrieve()
# and re-enable the RAG server + Qdrant to use vector retrieval for uploaded docs)
# ============================================================
# RAG_SERVER_URL = os.environ.get("RAG_SERVER_URL", "http://localhost:8001")
# RAG_TOP_K = 4
#
#
# def rag_retrieve(query: str) -> str:
#     """Query the RAG server and return formatted context chunks, or empty string on failure."""
#     try:
#         resp = requests.post(
#             f"{RAG_SERVER_URL}/api/search",
#             json={"query": query, "top_k": RAG_TOP_K},
#             timeout=10,
#         )
#         if resp.status_code != 200:
#             return ""
#         results = resp.json().get("results", [])
#         if not results:
#             return ""
#         parts = []
#         for i, r in enumerate(results, 1):
#             src = r.get("filename", "manual")
#             parts.append(f"[Excerpt {i} — {src}]\n{r['text']}")
#         return "\n\n".join(parts)
#     except Exception:
#         return ""


# ============================================================
# CONFIG
# ============================================================
BROKER = os.environ.get("MQTT_BROKER_HOST", "localhost")
PORT   = 1883

# Ollama settings
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_MODEL    = os.environ.get("OLLAMA_MODEL", "qwen3.5:4b")
OLLAMA_URL      = f"{OLLAMA_BASE_URL}/api/chat"
OLLAMA_NUM_CTX  = int(os.environ.get("OLLAMA_NUM_CTX", "4096"))
# Thinking/reasoning models (Qwen3, DeepSeek-R1, etc.) emit <think>...</think> and
# are slow on CPU. Disable thinking by default for this deployment; set
# OLLAMA_THINK=true to re-enable. Non-thinking models (qwen2.5) that reject the
# field are handled automatically (see call_llm).
OLLAMA_THINK    = os.environ.get("OLLAMA_THINK", "false").strip().lower() in ("1", "true", "yes", "on")

# MQTT Topics
TOPIC_HEARTBEAT = "factory/pumphouse4/boiler/unit01/system/heartbeat"
TOPIC_ANOMALY = "factory/pumphouse4/boiler/unit01/ai/anomaly_score"
TOPIC_ALERTS = "factory/pumphouse4/boiler/unit01/alerts"
TOPIC_CHAT_IN = "factory/pumphouse4/boiler/unit01/ai/question"
TOPIC_CHAT_OUT = "factory/pumphouse4/boiler/unit01/ai/response"
TOPIC_DIAGNOSIS = "factory/pumphouse4/boiler/unit01/ai/diagnosis"
TOPIC_AI_STATUS = "factory/pumphouse4/boiler/unit01/ai/status"

# Closed-loop autonomous control
TOPIC_CONTROL_CMD    = "factory/pumphouse4/boiler/control/setpoint"      # AI → engine command bus
TOPIC_CONTROL_ACTION = "factory/pumphouse4/boiler/unit01/ai/control_action"  # AI → dashboard console

# Debounce: one diagnosis per anomaly event
DIAGNOSIS_COOLDOWN = 30  # seconds between diagnoses

# ============================================================
# CHAT SYSTEM PROMPT  (defined ONCE at module level so it is byte-identical on
# every call — this lets Ollama reuse the cached KV state of the prefix, so the
# static manual core costs ~0 latency after the startup warmup.)
# STATIC_CORE (baselines, limits, answer style) lives here instead of RAG so it
# is always present and cache-friendly. Situational manual notes are appended to
# the USER message by route_manual().
# ============================================================
CHAT_SYSTEM_PROMPT = (
    "You are a boiler operations expert AI for NEXUS OS monitoring BOILER-01. "
    "A deterministic physics engine has already computed the current plant state — "
    "you MUST anchor your answer to the specific sensor values and computed findings provided. "
    "The SAFETY POLICY LAYER is mandatory and overrides any generic maintenance habit. "
    "If it marks evidence as contradictory, say the telemetry is inconsistent and prefer verification. "
    "Never include blocked action classes. "
    "Do NOT give generic boiler theory. "
    "Cite actual numbers: 'efficiency is 73.2%, 16.1% below the 87% baseline because...' "
    "When HISTORIAN CONTEXT is present, prefer it for historical claims and include the queried range. "
    "If the user asked for a simple historical metric, answer only the metric and comparison to baseline, "
    "without explaining causes unless the user explicitly asks why. "
    "FORMATTING (strict): "
    "**bold** for sensor names/values only. Dash bullet lists for recommendations. "
    "No markdown tables, no HTML, no headers (##). Max 180 words. "
    "Resolve follow-up questions using the conversation history."
    "\n\n" + STATIC_CORE
)

BASELINES = {
    "steam_pressure": 10.0,
    "steam_temperature": 180.0,
    "steam_flow": 2300.0,
    "drum_level": 400.0,
    "feedwater_flow": 2300.0,
    "feedwater_temp": 95.0,
    "fuel_flow": 138.0,
    "air_flow": 1518.0,
    "o2_percent": 3.2,
    "flue_gas_temp": 198.0,
    "tube_health": 97.0,
    "efficiency": 87.0,
}

THRESHOLDS = {
    "steam_pressure_high": 13.0,
    "steam_pressure_trip": 13.5,
    "drum_level_low": 280.0,
    "drum_level_critical": 200.0,
    "drum_level_high": 600.0,
    "drum_level_high_critical": 720.0,
    "flue_gas_temp_high": 240.0,
    "o2_percent_high": 5.5,
    "o2_percent_low": 2.0,
    "tube_health_inspect": 70.0,
}

OEE_RATED_STEAM_FLOW_KGHR = 2300.0
OEE_MIN_PRESSURE_BAR = 9.0
OEE_MAX_PRESSURE_BAR = 12.0
OEE_MIN_STEAM_TEMP_C = 170.0
OEE_MAX_STEAM_TEMP_C = 195.0
OEE_MIN_DRUM_LEVEL_MM = 280.0
OEE_MAX_DRUM_LEVEL_MM = 600.0

# ── Shift schedule ──────────────────────────────────────────────────────────
# Fixed clock-based 8h shifts. The end-of-shift report covers the current shift
# window [shift_start, now], not "since the analyst process started". Boundaries
# are the local-clock start hours; override with SHIFT_START_HOURS="6,14,22".
SHIFT_LENGTH_HOURS = int(os.environ.get("SHIFT_LENGTH_HOURS", "8"))
SHIFT_START_HOURS = sorted({
    int(h) for h in os.environ.get("SHIFT_START_HOURS", "6,14,22").split(",") if h.strip() != ""
})
# Friendly names for the default day/swing/night schedule.
_SHIFT_NAMES = {6: "Day", 14: "Swing", 22: "Night"}

OPTIMAL = {
    "o2_percent_low": 2.0,
    "o2_percent_high": 4.0,
    "air_fuel_ratio": 11.0,
}

TAG_METADATA = {
    "steam_pressure": {
        "label": "Steam pressure",
        "unit": "bar",
        "aliases": ("steam pressure", "pressure", "boiler pressure"),
        "decimals": 2,
        "high_warn": THRESHOLDS["steam_pressure_high"],
        "high_crit": THRESHOLDS["steam_pressure_trip"],
        "status": "higher",
    },
    "steam_temperature": {
        "label": "Steam temperature",
        "unit": "°C",
        "aliases": ("steam temperature", "steam temp", "temperature", "temp"),
        "decimals": 1,
    },
    "steam_flow": {
        "label": "Steam flow",
        "unit": "kg/hr",
        "aliases": ("steam flow", "steam output", "steam production"),
        "decimals": 0,
    },
    "drum_level": {
        "label": "Drum level",
        "unit": "mm",
        "aliases": ("drum level", "water level", "level"),
        "decimals": 1,
        "low_warn": THRESHOLDS["drum_level_low"],
        "low_crit": THRESHOLDS["drum_level_critical"],
        "high_warn": THRESHOLDS["drum_level_high"],
        "high_crit": THRESHOLDS["drum_level_high_critical"],
        "status": "band",
        "range_note": "Dashboard range is 0-800 mm; normal control target is 400 mm.",
    },
    "feedwater_flow": {
        "label": "Feedwater flow",
        "unit": "kg/hr",
        "aliases": ("feedwater flow", "feed water flow", "water flow"),
        "decimals": 0,
    },
    "feedwater_temp": {
        "label": "Feedwater temperature",
        "unit": "°C",
        "aliases": ("feedwater temperature", "feedwater temp", "feed water temperature", "feed water temp"),
        "decimals": 1,
    },
    "fuel_flow": {
        "label": "Fuel flow",
        "unit": "m³/hr",
        "aliases": ("fuel flow", "gas flow", "fuel"),
        "decimals": 1,
    },
    "air_flow": {
        "label": "Air flow",
        "unit": "m³/hr",
        "aliases": ("air flow", "combustion air"),
        "decimals": 0,
    },
    "o2_percent": {
        "label": "O₂",
        "unit": "%",
        "aliases": ("o2", "o₂", "oxygen", "oxygen percent", "oxygen percentage"),
        "decimals": 2,
        "low_warn": THRESHOLDS["o2_percent_low"],
        "high_warn": OPTIMAL["o2_percent_high"],
        "high_crit": THRESHOLDS["o2_percent_high"],
        "status": "band",
    },
    "flue_gas_temp": {
        "label": "Flue gas temperature",
        "unit": "°C",
        "aliases": ("flue gas temperature", "flue gas temp", "stack temperature", "stack temp", "fgt"),
        "decimals": 1,
        "high_warn": 220.0,
        "high_crit": THRESHOLDS["flue_gas_temp_high"],
        "status": "higher",
    },
    "tube_health": {
        "label": "Tube health",
        "unit": "%",
        "aliases": ("tube health", "tube condition", "tube"),
        "decimals": 1,
        "low_warn": 80.0,
        "low_crit": THRESHOLDS["tube_health_inspect"],
        "status": "lower",
    },
    "efficiency": {
        "label": "Efficiency",
        "unit": "%",
        "aliases": ("efficiency", "boiler efficiency"),
        "decimals": 1,
        "low_warn": 82.0,
        "low_crit": 75.0,
        "status": "lower",
    },
    "heat_rate": {
        "label": "Heat rate",
        "unit": "kJ/kg",
        "aliases": ("heat rate", "heatrate"),
        "decimals": 0,
    },
    "flame_status": {
        "label": "Flame status",
        "unit": "",
        "aliases": ("flame", "flame status", "burner flame"),
        "decimals": 0,
    },
    "safety_valve": {
        "label": "Safety valve",
        "unit": "",
        "aliases": ("safety valve", "relief valve"),
        "decimals": 0,
    },
}


def _as_float(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _fmt_value(value, decimals, unit):
    if isinstance(value, bool):
        return "ON" if value else "OFF"
    if isinstance(value, str):
        return value
    if value is None:
        return "--"
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return str(value)
    if decimals == 0:
        text = f"{numeric:.0f}"
    else:
        text = f"{numeric:.{decimals}f}"
    return f"{text} {unit}".strip()


def _status_for_tag(tag, value):
    meta = TAG_METADATA.get(tag, {})
    if tag == "flame_status":
        return "ON - burner flame proven." if value else "OFF - burner flame not proven."
    if tag == "safety_valve":
        return "OPEN - safety valve is lifting." if value else "CLOSED - normal standby state."

    val = _as_float(value, None)
    if val is None:
        return "Status unavailable."

    low_crit = meta.get("low_crit")
    low_warn = meta.get("low_warn")
    high_warn = meta.get("high_warn")
    high_crit = meta.get("high_crit")

    if low_crit is not None and val < low_crit:
        return f"CRITICAL low: below {low_crit:g} {meta.get('unit', '')}".strip()
    if low_warn is not None and val < low_warn:
        return f"Low warning: below {low_warn:g} {meta.get('unit', '')}".strip()
    if high_crit is not None and val >= high_crit:
        return f"CRITICAL high: at/above {high_crit:g} {meta.get('unit', '')}".strip()
    if high_warn is not None and val > high_warn:
        return f"High warning: above {high_warn:g} {meta.get('unit', '')}".strip()
    return "Normal against configured dashboard thresholds."


def _find_requested_tag(question):
    q = question.lower()
    for tag, meta in TAG_METADATA.items():
        for alias in meta["aliases"]:
            pattern = r"(?<![a-z0-9])" + re.escape(alias.lower()) + r"(?![a-z0-9])"
            if re.search(pattern, q):
                return tag
    return None


def _is_current_value_question(question, tag):
    if not tag:
        return False
    q = question.lower()
    if _is_control_loop_question(q):
        return False
    historical_terms = (
        "yesterday", "today", "shift", "last ", "past ", "week", "month",
        "history", "historian", "trend", "average", "avg", "minimum",
        "maximum", "highest", "lowest", "worst", "compare", "before",
    )
    if any(term in q for term in historical_terms):
        return False
    current_terms = (
        "what is", "what's", "current", "now", "right now", "reading",
        "value", "show", "tell me", "how much", "status"
    )
    diagnostic_terms = (
        "why", "cause", "recommend", "should", "what should", "fix",
        "action", "diagnose", "predict", "fail", "failure", "what if",
        "how to", "explain", "because"
    )
    return any(term in q for term in current_terms) and not any(term in q for term in diagnostic_terms)


def _is_control_loop_question(question):
    q = (question or "").lower()
    loop_terms = (
        "pid", "control loop", "controller", "loop", "hunting", "oscillat",
        "stable", "stability", "windup", "saturated", "saturation",
        "overshoot", "overcorrect", "setpoint", "tuning", "gain",
        "kp", "ki", "kd"
    )
    process_terms = (
        "pressure", "steam", "o2", "o₂", "oxygen", "air", "combustion",
        "drum", "level", "feedwater", "fuel"
    )
    return any(term in q for term in loop_terms) and any(term in q for term in process_terms)


def build_current_value_answer(question, latest_reading, force=False):
    # force=True: the intent was already decided (e.g. by the LLM router) so skip
    # the brittle keyword gate. force=False keeps the keyword heuristic as a fast
    # fallback for when the router LLM is unreachable.
    tag = _find_requested_tag(question)
    if not force and not _is_current_value_question(question, tag):
        return None
    if not tag:
        return None
    if not latest_reading:
        return "No live telemetry has arrived yet, so I cannot read that value right now."

    tags = latest_reading.get("tags", {})
    if tag not in tags:
        return None

    meta = TAG_METADATA[tag]
    value = tags.get(tag)
    unit = meta.get("unit", "")
    decimals = meta.get("decimals", 1)
    value_text = _fmt_value(value, decimals, unit)
    label = meta["label"]

    lines = [f"**{label}** is **{value_text}** right now."]

    if tag in BASELINES and isinstance(value, (int, float)):
        baseline = BASELINES[tag]
        delta = float(value) - baseline
        pct = (delta / baseline * 100.0) if baseline else 0.0
        direction = "above" if delta > 0 else "below" if delta < 0 else "at"
        if abs(delta) < 0.01:
            lines.append(f"Baseline/setpoint is **{_fmt_value(baseline, decimals, unit)}**; current value is essentially at baseline.")
        else:
            lines.append(
                f"Baseline/setpoint is **{_fmt_value(baseline, decimals, unit)}**; "
                f"current value is **{_fmt_value(abs(delta), decimals, unit)} {direction}** baseline ({pct:+.1f}%)."
            )

    lines.append(f"Status: {_status_for_tag(tag, value)}")

    if meta.get("range_note"):
        lines.append(meta["range_note"])

    lines.append("I am only reporting the live value here; ask for diagnosis or recommended actions if you want next steps.")
    return "\n".join(lines)


def _series_stats(samples, tag):
    values = []
    for sample in samples:
        val = sample.get("tags", {}).get(tag)
        try:
            values.append(float(val))
        except (TypeError, ValueError):
            pass
    if not values:
        return None
    return {
        "first": values[0],
        "last": values[-1],
        "min": min(values),
        "max": max(values),
        "span": max(values) - min(values),
        "n": len(values),
    }


def _fmt_span(stats, unit, decimals=2):
    if not stats:
        return "unavailable"
    return (
        f"{stats['last']:.{decimals}f} {unit} now; "
        f"range {stats['min']:.{decimals}f}-{stats['max']:.{decimals}f} {unit} "
        f"(span {stats['span']:.{decimals}f}) over {stats['n']} samples"
    )


def build_control_loop_context(question, samples, brief):
    if not _is_control_loop_question(question):
        return ""

    q = question.lower()
    lines = ["CONTROL LOOP STABILITY CONTEXT:"]
    if "pressure" in q or "steam" in q or "fuel" in q or "pid" in q:
        lines.append(f"- Pressure loop PV: {_fmt_span(_series_stats(samples, 'steam_pressure'), 'bar', 3)}")
        lines.append(f"- Pressure loop output: fuel flow {_fmt_span(_series_stats(samples, 'fuel_flow'), 'm3/hr', 2)}")
        lines.append("- Pressure setpoint: 10.0 bar; PID output drives fuel_flow.")
    if "o2" in q or "o₂" in q or "oxygen" in q or "air" in q or "combustion" in q or "pid" in q:
        lines.append(f"- O2 loop PV: {_fmt_span(_series_stats(samples, 'o2_percent'), '%', 3)}")
        lines.append(f"- O2 loop output: air flow {_fmt_span(_series_stats(samples, 'air_flow'), 'm3/hr', 1)}")
        lines.append("- O2 setpoint: 3.2%; PID output drives air_flow.")
    if "drum" in q or "level" in q or "feedwater" in q or "pid" in q:
        lines.append(f"- Drum level loop PV: {_fmt_span(_series_stats(samples, 'drum_level'), 'mm', 1)}")
        lines.append(f"- Drum level output: feedwater flow {_fmt_span(_series_stats(samples, 'feedwater_flow'), 'kg/hr', 1)}")
        lines.append("- Drum level setpoint: 400 mm; PID trim plus steam-flow feedforward drives feedwater_flow.")

    if brief.pid_issues:
        lines.append("- Deterministic PID detector found:")
        for issue in brief.pid_issues:
            lines.append(f"  {issue.loop}: {issue.symptom} Diagnosis: {issue.diagnosis}")
    else:
        lines.append("- Deterministic PID detector found no hunting/windup issue in the recent window.")
    lines.append("Answer the operator's stability question directly first, then explain the evidence.")
    return "\n".join(lines) + "\n\n"


def is_oee_question(question):
    q = question.lower()
    oee_terms = (
        "oee", "overall equipment effectiveness", "availability",
        "performance factor", "quality factor", "good steam",
        "bad steam", "defective steam"
    )
    calculation_terms = (
        "calculate", "calculation", "formula", "how do i", "how to",
        "what is", "what's", "explain", "show", "shift", "current"
    )
    return any(term in q for term in oee_terms) and any(term in q for term in calculation_terms)


def _pct(value):
    return f"{value * 100.0:.2f}%"


def _kg(value):
    return f"{value:.1f} kg"


def _wants_oee_working(question):
    q = question.lower()
    detail_terms = (
        "show calculation", "show the calculation", "step by step",
        "working", "workings", "breakdown", "show math", "show maths",
        "formula", "method", "how do you calculate", "how is it calculated"
    )
    return any(term in q for term in detail_terms)


def _format_oee_formula(snapshot):
    return (
        "OEE for this boiler should be calculated as:\n"
        "- Availability = available boiler time / planned boiler time\n"
        "- Performance = actual steam mass / rated steam mass during available time\n"
        "- Quality = good steam mass / total steam mass\n"
        "- OEE = Availability x Performance x Quality\n\n"
        "For BOILER-01, good steam means flame proven, no safety-valve lift, not in FAULT mode, "
        f"pressure {OEE_MIN_PRESSURE_BAR:.1f}-{OEE_MAX_PRESSURE_BAR:.1f} bar, "
        f"steam temperature {OEE_MIN_STEAM_TEMP_C:.0f}-{OEE_MAX_STEAM_TEMP_C:.0f} °C, and "
        f"drum level {OEE_MIN_DRUM_LEVEL_MM:.0f}-{OEE_MAX_DRUM_LEVEL_MM:.0f} mm. "
        f"The current rated steam basis is {OEE_RATED_STEAM_FLOW_KGHR:.0f} kg/hr."
    )


def build_oee_answer(question, stats_snapshot):
    if not is_oee_question(question):
        return None

    q = question.lower()
    if stats_snapshot.get("oee_samples", 0) <= 0:
        return _format_oee_formula(stats_snapshot)

    oee = stats_snapshot.get("oee", {})
    availability = oee.get("availability", 0.0)
    performance = oee.get("performance", 0.0)
    quality = oee.get("quality", 0.0)
    overall = oee.get("oee", 0.0)

    planned_seconds = oee.get("planned_seconds", 0.0)
    available_seconds = oee.get("available_seconds", 0.0)
    actual_steam_kg = oee.get("actual_steam_kg", 0.0)
    available_steam_kg = oee.get("available_steam_kg", actual_steam_kg)
    rated_steam_kg = oee.get("rated_steam_kg", 0.0)
    good_steam_kg = oee.get("good_steam_kg", 0.0)
    bad_steam_kg = max(0.0, actual_steam_kg - good_steam_kg)
    show_working = _wants_oee_working(question)

    if show_working and ("formula" in q or "method" in q or "how" in q):
        return _format_oee_formula(stats_snapshot)

    if "availability" in q and "oee" not in q:
        if show_working:
            return (
                f"Availability is **{_pct(availability)}** for this shift window. "
                f"Calculation: **{available_seconds:.0f} s available / {planned_seconds:.0f} s planned**. "
                "I count the boiler as available when the flame is proven and the unit is not in FAULT mode."
            )
        return f"Availability is **{_pct(availability)}** for this shift window."

    if "performance" in q and "oee" not in q:
        if show_working:
            return (
                f"Performance is **{_pct(performance)}** for this shift window. "
                f"Calculation: **{_kg(available_steam_kg)} steam during available time / {_kg(rated_steam_kg)} rated steam** "
                f"during available time, using **{OEE_RATED_STEAM_FLOW_KGHR:.0f} kg/hr** as the rated basis."
            )
        return f"Performance is **{_pct(performance)}** for this shift window."

    if ("quality" in q or "good steam" in q or "defective steam" in q or "bad steam" in q) and "oee" not in q:
        if show_working:
            return (
                f"Quality is **{_pct(quality)}** for this shift window. "
                f"Calculation: **{_kg(good_steam_kg)} good steam / {_kg(actual_steam_kg)} total steam**. "
                f"Estimated out-of-spec steam is **{_kg(bad_steam_kg)}**. "
                "Good steam requires pressure, temperature, drum level, flame, safety valve, and mode to be inside the BOILER-01 limits."
            )
        return f"Quality is **{_pct(quality)}** for this shift window."

    if not show_working:
        return (
            f"Current shift OEE is **{_pct(overall)}**. "
            f"Availability is **{_pct(availability)}**, performance is **{_pct(performance)}**, "
            f"and quality is **{_pct(quality)}**."
        )

    return (
        f"Current shift OEE is **{_pct(overall)}**.\n"
        f"- Availability: **{_pct(availability)}** = {available_seconds:.0f} s / {planned_seconds:.0f} s\n"
        f"- Performance: **{_pct(performance)}** = {_kg(available_steam_kg)} / {_kg(rated_steam_kg)} at rated capacity\n"
        f"- Quality: **{_pct(quality)}** = {_kg(good_steam_kg)} / {_kg(actual_steam_kg)}\n"
        f"- OEE: **{_pct(availability)} x {_pct(performance)} x {_pct(quality)} = {_pct(overall)}**\n\n"
        "As a boiler metric, keep OEE separate from thermal efficiency: OEE tells whether the asset produced good steam on time, "
        "while boiler efficiency tells how much fuel energy was converted into useful steam energy."
    )

# ============================================================
# TELEMETRY RING BUFFER (last N minutes of context)
# ============================================================
class TelemetryBuffer:
    def __init__(self, max_samples=120):
        self.buffer = deque(maxlen=max_samples)
        self.lock = Lock()
        self.latest = None

    def add(self, reading):
        with self.lock:
            self.buffer.append(reading)
            self.latest = reading

    def get_context(self, last_n=30):
        """Get last N readings as context string for prompt injection."""
        with self.lock:
            samples = list(self.buffer)[-last_n:]
        if not samples:
            return "No telemetry data available yet."

        lines = []
        for s in samples:
            tags = s.get("tags", {})
            ts = s.get("timestamp", "?")
            line = (
                f"[{ts}] P={tags.get('steam_pressure','?')} bar, "
                f"T={tags.get('steam_temperature','?')}°C, "
                f"Drum={tags.get('drum_level','?')}mm, "
                f"Fuel={tags.get('fuel_flow','?')} m³/hr, "
                f"FGT={tags.get('flue_gas_temp','?')}°C, "
                f"O2={tags.get('o2_percent','?')}%, "
                f"Eff={tags.get('efficiency','?')}%, "
                f"Tube={tags.get('tube_health','?')}%, "
                f"Flame={'ON' if tags.get('flame_status',1) else 'OFF'}, "
                f"Mode={s.get('mode','NORMAL')}"
            )
            lines.append(line)
        return "\n".join(lines)

    def get_latest_summary(self):
        """Get a concise summary of the latest reading."""
        with self.lock:
            if not self.latest:
                return "No data available."
            tags = self.latest.get("tags", {})
            mode = self.latest.get("mode", "NORMAL")
            deg = self.latest.get("degradation_factor", 0)

        return (
            f"Mode: {mode} | Degradation: {deg:.3f}\n"
            f"Steam Pressure: {tags.get('steam_pressure','?')} bar\n"
            f"Steam Temperature: {tags.get('steam_temperature','?')} °C\n"
            f"Steam Flow: {tags.get('steam_flow','?')} kg/hr\n"
            f"Drum Level: {tags.get('drum_level','?')} mm\n"
            f"Feedwater Flow: {tags.get('feedwater_flow','?')} kg/hr\n"
            f"Feedwater Temp: {tags.get('feedwater_temp','?')} °C\n"
            f"Fuel Flow: {tags.get('fuel_flow','?')} m³/hr\n"
            f"Air Flow: {tags.get('air_flow','?')} m³/hr\n"
            f"O₂: {tags.get('o2_percent','?')} %\n"
            f"Flue Gas Temp: {tags.get('flue_gas_temp','?')} °C\n"
            f"Tube Health: {tags.get('tube_health','?')} %\n"
            f"Efficiency: {tags.get('efficiency','?')} %\n"
            f"Flame: {'ON' if tags.get('flame_status',1) else 'OFF'}\n"
            f"Safety Valve: {'OPEN' if tags.get('safety_valve',0) else 'CLOSED'}"
        )

    def get_recent_samples(self, last_n=30):
        with self.lock:
            return list(self.buffer)[-last_n:]


# ============================================================
# SHIFT STATISTICS (feeds the end-of-shift report)
# ============================================================
class ShiftStats:
    def __init__(self):
        self.lock = Lock()
        self.start_time = time.time()
        self.last_sample_time = None
        self.anomaly_events = 0
        self.alert_counts = {"CRITICAL": 0, "HIGH": 0, "WARNING": 0, "LOW": 0}
        self.samples = 0
        self.flame_off_samples = 0
        self.oee_available_seconds = 0.0
        self.oee_actual_steam_kg = 0.0
        self.oee_available_steam_kg = 0.0
        self.oee_rated_steam_kg = 0.0
        self.oee_good_steam_kg = 0.0
        self.eff_start = None
        self.eff_end = None
        self.eff_min = None
        self.eff_max = None
        self.modes_seen = set()

    def record_reading(self, reading):
        tags = reading.get("tags", {})
        eff = tags.get("efficiency")
        now = time.time()
        mode = reading.get("mode", "NORMAL")
        flame_on = bool(tags.get("flame_status", 1))
        safety_closed = not bool(tags.get("safety_valve", 0))
        available = flame_on and mode != "FAULT"
        good_steam = (
            available
            and safety_closed
            and OEE_MIN_PRESSURE_BAR <= _as_float(tags.get("steam_pressure"), -999.0) <= OEE_MAX_PRESSURE_BAR
            and OEE_MIN_STEAM_TEMP_C <= _as_float(tags.get("steam_temperature"), -999.0) <= OEE_MAX_STEAM_TEMP_C
            and OEE_MIN_DRUM_LEVEL_MM <= _as_float(tags.get("drum_level"), -999.0) <= OEE_MAX_DRUM_LEVEL_MM
        )

        with self.lock:
            if self.last_sample_time is None:
                dt = 1.0
            else:
                dt = max(0.0, min(now - self.last_sample_time, 5.0))
            self.last_sample_time = now

            self.samples += 1
            if not flame_on:
                self.flame_off_samples += 1
            self.modes_seen.add(mode)
            steam_flow = max(0.0, _as_float(tags.get("steam_flow"), 0.0))
            steam_kg = steam_flow * dt / 3600.0
            self.oee_actual_steam_kg += steam_kg
            if available:
                self.oee_available_seconds += dt
                self.oee_available_steam_kg += steam_kg
                self.oee_rated_steam_kg += OEE_RATED_STEAM_FLOW_KGHR * dt / 3600.0
            if good_steam:
                self.oee_good_steam_kg += steam_kg
            if eff is not None:
                if self.eff_start is None:
                    self.eff_start = eff
                self.eff_end = eff
                self.eff_min = eff if self.eff_min is None else min(self.eff_min, eff)
                self.eff_max = eff if self.eff_max is None else max(self.eff_max, eff)

    def record_anomaly(self):
        with self.lock:
            self.anomaly_events += 1

    def record_alert(self, severity):
        with self.lock:
            if severity in self.alert_counts:
                self.alert_counts[severity] += 1

    def snapshot(self):
        with self.lock:
            elapsed = time.time() - self.start_time
            hours, rem = divmod(int(elapsed), 3600)
            minutes = rem // 60
            uptime_pct = 100.0
            if self.samples > 0:
                uptime_pct = 100.0 * (1 - self.flame_off_samples / self.samples)
            availability = self.oee_available_seconds / elapsed if elapsed > 0 else 0.0
            performance = self.oee_available_steam_kg / self.oee_rated_steam_kg if self.oee_rated_steam_kg > 0 else 0.0
            quality = self.oee_good_steam_kg / self.oee_actual_steam_kg if self.oee_actual_steam_kg > 0 else 0.0
            availability = max(0.0, min(availability, 1.0))
            performance = max(0.0, min(performance, 1.5))
            quality = max(0.0, min(quality, 1.0))
            return {
                "shift_duration": f"{hours}h {minutes:02d}m",
                "uptime_pct": round(uptime_pct, 1),
                "oee_samples": self.samples,
                "oee": {
                    "availability": round(availability, 4),
                    "performance": round(performance, 4),
                    "quality": round(quality, 4),
                    "oee": round(availability * performance * quality, 4),
                    "planned_seconds": round(elapsed, 1),
                    "available_seconds": round(self.oee_available_seconds, 1),
                    "actual_steam_kg": round(self.oee_actual_steam_kg, 2),
                    "available_steam_kg": round(self.oee_available_steam_kg, 2),
                    "rated_steam_kg": round(self.oee_rated_steam_kg, 2),
                    "good_steam_kg": round(self.oee_good_steam_kg, 2),
                    "rated_steam_flow_kg_hr": OEE_RATED_STEAM_FLOW_KGHR,
                    "good_steam_limits": {
                        "pressure_bar": [OEE_MIN_PRESSURE_BAR, OEE_MAX_PRESSURE_BAR],
                        "steam_temp_c": [OEE_MIN_STEAM_TEMP_C, OEE_MAX_STEAM_TEMP_C],
                        "drum_level_mm": [OEE_MIN_DRUM_LEVEL_MM, OEE_MAX_DRUM_LEVEL_MM],
                    },
                },
                "anomaly_events": self.anomaly_events,
                "alerts": dict(self.alert_counts),
                "efficiency": {
                    "start": self.eff_start,
                    "end": self.eff_end,
                    "min": self.eff_min,
                    "max": self.eff_max,
                },
                "modes_seen": sorted(self.modes_seen),
            }


# ============================================================
# INCIDENT MEMORY (multi-turn incident correlation)
# ============================================================
class IncidentMemory:
    """
    Session-scoped memory of alert episodes and AI diagnoses.
    Lets later prompts correlate recurring patterns, e.g.
    "third flue gas temp spike this session — matches tube fouling,
    not a one-off transient."
    """

    ALERT_EPISODE_GAP = 60  # seconds — alert ticks closer than this count as one episode

    def __init__(self, max_incidents=50):
        self.lock = Lock()
        self.incidents = deque(maxlen=max_incidents)
        self._last_alert_seen = {}  # tag -> last time an alert tick was seen

    def record_alert(self, payload):
        """Record an alert episode (deduplicates the 1 Hz alarm ticks)."""
        tag = payload.get("tag", "unknown")
        now = time.time()
        with self.lock:
            last = self._last_alert_seen.get(tag, 0)
            self._last_alert_seen[tag] = now
            if now - last < self.ALERT_EPISODE_GAP:
                return  # same continuous episode, already recorded
            self.incidents.append({
                "time": time.strftime("%H:%M:%S"),
                "kind": "ALERT",
                "tag": tag,
                "severity": payload.get("severity", "?"),
                "detail": (
                    f"{payload.get('message', '')} "
                    f"({tag}={payload.get('value', '?')}, threshold {payload.get('threshold', '?')})"
                ),
            })

    def record_diagnosis(self, diagnosis):
        with self.lock:
            self.incidents.append({
                "time": time.strftime("%H:%M:%S"),
                "kind": "DIAGNOSIS",
                "tag": "",
                "severity": diagnosis.get("severity", "?"),
                "detail": diagnosis.get("probable_cause", "Unknown cause"),
            })

    def summary(self):
        """Compact incident history string for prompt injection."""
        with self.lock:
            incidents = list(self.incidents)
        if not incidents:
            return "No prior incidents this session."

        lines = [
            f"- [{i['time']}] {i['kind']} [{i['severity']}]"
            f"{' ' + i['tag'] if i['tag'] else ''}: {i['detail']}"
            for i in incidents[-12:]
        ]
        tag_counts = {}
        for i in incidents:
            if i["kind"] == "ALERT":
                tag_counts[i["tag"]] = tag_counts.get(i["tag"], 0) + 1
        out = f"{len(incidents)} incident(s) recorded this session:\n" + "\n".join(lines)
        recurring = [f"{tag} x{n}" for tag, n in tag_counts.items() if n >= 2]
        if recurring:
            out += "\nRecurring alert episodes: " + ", ".join(recurring)
        return out


# ============================================================
# UNIFIED LLM CLIENT  (Ollama)
# ============================================================
# Session flag: set False if the model rejects the "think" field, so we only pay
# the retry-without-think once and never send it again this run.
_THINK_SUPPORTED = True


def _strip_think(text):
    """
    Remove <think>...</think> reasoning blocks from a model reply.
    Thinking models (Qwen3, DeepSeek-R1) wrap their scratch reasoning in these tags;
    only the text after the block is the real answer. Handles unclosed blocks too.
    """
    if not text:
        return text
    # Drop complete reasoning blocks.
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL | re.IGNORECASE)
    # If a closing tag remains (opening was trimmed), keep only what follows it.
    if "</think>" in text:
        text = text.split("</think>")[-1]
    # Strip any stray tags.
    text = re.sub(r"</?think>", "", text, flags=re.IGNORECASE)
    return text.strip()


def call_llm(messages, json_mode=False, max_tokens=800, think=None):
    """
    Send a chat completion request to the native Ollama server.
    Optimized for Intel Mac CPU inference over local Wi-Fi.

    think: None -> use the OLLAMA_THINK default; True/False -> force per-call.
    Thinking is disabled by default (faster on CPU, clean YES/NO for the guardrail);
    if the model doesn't support the "think" field we drop it and retry once.
    """
    global _THINK_SUPPORTED
    url     = OLLAMA_URL
    headers = {"Content-Type": "application/json"}
    model   = OLLAMA_MODEL
    timeout = 90   # Smaller prompts (PhysicsBrief vs raw dump) comfortably fit in 90s

    body = {
        "model": model,
        "messages": messages,
        "stream": False,
        "keep_alive": "1h",  # Crucial: Keeps model in Mac's RAM between alerts
        "options": {
            "temperature": 0.2,
            "num_predict": max_tokens,
            "num_ctx": OLLAMA_NUM_CTX
        }
    }

    if json_mode:
        body["format"] = "json"  # Native Ollama JSON mode

    want_think = OLLAMA_THINK if think is None else think
    if want_think is not None and _THINK_SUPPORTED:
        body["think"] = bool(want_think)

    for attempt in range(3):
        try:
            resp = requests.post(url, headers=headers, json=body, timeout=timeout)
            if resp.status_code == 200:
                # Native Ollama response parsing (strip any reasoning block)
                return _strip_think(resp.json()["message"]["content"])
            # Some models reject the "think" field — drop it and retry cleanly.
            if "think" in body:
                print("[AI Analyst] Model rejected 'think' field — disabling and retrying")
                _THINK_SUPPORTED = False
                body.pop("think", None)
                continue
            print(f"[AI Analyst] Ollama error {resp.status_code}: {resp.text[:200]}")
            return None
        except requests.exceptions.Timeout:
            print(f"[AI Analyst] Timeout (attempt {attempt+1}/3)")
        except Exception as e:
            print(f"[AI Analyst] Request error: {e}")
            return None

    return None


# ============================================================
# WHAT-IF RESPONSE NORMALIZATION
# ============================================================
# Small local models frequently ignore the requested what-if JSON schema and
# emit their own key names (consequence_chain, operator_action_recommendation,
# scenario-as-object, ...) or wrap the JSON in ```fences```. The dashboard
# WhatIfCard only renders {scenario, risk_level, summary, steps[], operator_actions[]},
# so without coercion the card renders blank or the raw JSON is dumped to the
# operator. These helpers salvage whatever the model returned.

def _stringify_json_value(val):
    """Flatten any scalar/dict/list into a compact, human-readable string."""
    if val is None:
        return ""
    if isinstance(val, str):
        return val
    if isinstance(val, bool):
        return "yes" if val else "no"
    if isinstance(val, (int, float)):
        return str(val)
    if isinstance(val, dict):
        return "; ".join(
            f"{str(k).replace('_', ' ')}: {_stringify_json_value(v)}"
            for k, v in val.items()
        )
    if isinstance(val, (list, tuple)):
        return "; ".join(_stringify_json_value(v) for v in val)
    return str(val)


def _coerce_json_object(text):
    """
    Parse model JSON that may be wrapped in ```fences``` or padded with prose.
    Returns the parsed object, or None if nothing parseable is found.
    """
    if not text:
        return None
    t = text.strip()
    # Strip a leading/trailing markdown code fence (```json ... ```)
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z0-9]*\s*", "", t)
        t = re.sub(r"\s*```$", "", t).strip()
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        pass
    # Fall back to the outermost {...} block embedded in surrounding prose.
    start = t.find("{")
    end = t.rfind("}")
    if start != -1 and end > start:
        try:
            return json.loads(t[start:end + 1])
        except json.JSONDecodeError:
            return None
    return None


def normalize_what_if(sim):
    """
    Coerce arbitrary LLM JSON into the WhatIfCard schema the dashboard renders:
    {scenario, risk_level, summary, steps:[{step,event,consequence}], operator_actions:[str]}.
    Returns None if nothing salvageable is present (caller then sends a text answer).
    """
    if not isinstance(sim, dict):
        return None

    scenario = sim.get("scenario")
    scenario = _stringify_json_value(scenario) if scenario else ""

    # Steps — accept the common alternate key names small models drift to.
    steps_raw = (sim.get("steps") or sim.get("consequence_chain")
                 or sim.get("chain") or sim.get("consequences") or [])
    steps = []
    if isinstance(steps_raw, list):
        for i, s in enumerate(steps_raw, 1):
            if isinstance(s, dict):
                event = (s.get("event") or s.get("stage") or s.get("title")
                         or s.get("name") or "")
                consequence = (s.get("consequence") or s.get("description")
                               or s.get("effect") or s.get("detail") or "")
                impact = s.get("impact_on_systems") or s.get("impact")
                consequence = _stringify_json_value(consequence)
                if impact:
                    impact_txt = _stringify_json_value(impact)
                    consequence = f"{consequence} ({impact_txt})" if consequence else impact_txt
                steps.append({
                    "step": s.get("step", i),
                    "event": _stringify_json_value(event),
                    "consequence": consequence,
                })
            else:
                steps.append({"step": i, "event": _stringify_json_value(s), "consequence": ""})

    # Operator actions — may arrive as a list, a string, or a recommendation dict.
    actions_raw = (sim.get("operator_actions") or sim.get("operator_action_recommendation")
                   or sim.get("recommended_actions") or sim.get("actions")
                   or sim.get("recommendations") or [])
    actions = []
    if isinstance(actions_raw, str):
        if actions_raw.strip():
            actions = [actions_raw.strip()]
    elif isinstance(actions_raw, dict):
        primary = actions_raw.get("action") or actions_raw.get("recommendation")
        if primary:
            actions.append(_stringify_json_value(primary))
        for k in ("monitoring_focus", "monitoring", "follow_up", "follow_ups"):
            if actions_raw.get(k):
                actions.append(f"Monitor: {_stringify_json_value(actions_raw[k])}")
        if not actions:
            actions = [_stringify_json_value(actions_raw)]
    elif isinstance(actions_raw, list):
        actions = [_stringify_json_value(a) for a in actions_raw if a]

    # Summary — synthesize from a final-state block if the model omitted it.
    summary = sim.get("summary") or sim.get("assessment") or sim.get("overall_assessment")
    if not summary:
        fss = sim.get("final_state_summary") or sim.get("final_state")
        if fss:
            summary = _stringify_json_value(fss)
    summary = _stringify_json_value(summary) if summary else ""

    # Risk level — normalise to the card's four buckets.
    risk = _stringify_json_value(
        sim.get("risk_level") or sim.get("risk") or sim.get("severity") or ""
    ).lower().strip()
    if risk not in ("low", "medium", "high", "critical"):
        blob = json.dumps(sim).lower()
        if "critical" in blob:
            risk = "critical"
        elif "high" in blob:
            risk = "high"
        elif "low" in blob:
            risk = "low"
        else:
            risk = "medium"

    if not steps and not summary and not actions:
        return None  # nothing worth rendering as a card

    return {
        "scenario": scenario,
        "risk_level": risk,
        "summary": summary,
        "steps": steps,
        "operator_actions": actions,
    }


# ============================================================
# SHIFT REPORT NARRATIVE (deterministic floor)
# ============================================================
# Reasoning models (qwen3.5, deepseek-r1, ...) are verbose and can overrun the
# token budget or wrap the JSON, so the LLM narrative sometimes fails to parse.
# This builds a genuine narrative straight from the hard shift statistics so the
# operator always gets a reasoned report — never "narrative could not be
# generated". The LLM narrative, when it parses, layers on top of this.

def _shift_label(shift_start):
    """Human name for a shift, e.g. 'Day (06:00-14:00)'."""
    start_h = shift_start.hour
    end_h = (start_h + SHIFT_LENGTH_HOURS) % 24
    name = _SHIFT_NAMES.get(start_h, f"Shift {start_h:02d}00")
    return f"{name} ({start_h:02d}:00-{end_h:02d}:00)"


def current_shift_window(now=None):
    """
    Resolve the fixed clock-based shift that `now` falls in.
    Returns (shift_start, shift_end, label) as tz-aware local datetimes.
    Handles the night shift wrapping past midnight.
    """
    now = now or datetime.now().astimezone()
    if not SHIFT_START_HOURS:
        # Degenerate config — treat the whole day as one shift.
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        return start, start + timedelta(days=1), "Full day (00:00-24:00)"

    length = timedelta(hours=SHIFT_LENGTH_HOURS)
    candidates = []
    for day_offset in (-1, 0):
        base = (now + timedelta(days=day_offset)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        for h in SHIFT_START_HOURS:
            candidates.append(base + timedelta(hours=h))
    # Current shift = the latest start that is at or before now.
    shift_start = max(c for c in candidates if c <= now)
    shift_end = shift_start + length
    return shift_start, shift_end, _shift_label(shift_start)


def compute_shift_stats_from_rows(rows, planned_seconds, alerts, anomaly_events):
    """
    Recompute the shift snapshot (uptime, OEE, efficiency, modes) from historian
    telemetry rows over the shift window. Mirrors ShiftStats.record_reading /
    snapshot, but derives dt from consecutive row timestamps and uses the full
    elapsed shift time as the OEE 'planned' base — so telemetry gaps correctly
    read as unavailable time. Output is byte-compatible with ShiftStats.snapshot().
    """
    samples = 0
    flame_off = 0
    avail_s = 0.0
    actual_kg = avail_kg = rated_kg = good_kg = 0.0
    eff_start = eff_end = eff_min = eff_max = None
    modes = set()
    prev_t = None

    for r in rows:
        tags = r.get("tags", {})
        t = r["ts_epoch"]
        mode = r.get("mode") or "NORMAL"
        flame_on = bool(tags.get("flame_status", 1))
        safety_closed = not bool(tags.get("safety_valve", 0))
        available = flame_on and mode != "FAULT"
        good_steam = (
            available
            and safety_closed
            and OEE_MIN_PRESSURE_BAR <= _as_float(tags.get("steam_pressure"), -999.0) <= OEE_MAX_PRESSURE_BAR
            and OEE_MIN_STEAM_TEMP_C <= _as_float(tags.get("steam_temperature"), -999.0) <= OEE_MAX_STEAM_TEMP_C
            and OEE_MIN_DRUM_LEVEL_MM <= _as_float(tags.get("drum_level"), -999.0) <= OEE_MAX_DRUM_LEVEL_MM
        )

        dt = 1.0 if prev_t is None else max(0.0, min(t - prev_t, 5.0))
        prev_t = t

        samples += 1
        if not flame_on:
            flame_off += 1
        modes.add(mode)
        steam_flow = max(0.0, _as_float(tags.get("steam_flow"), 0.0))
        steam_kg = steam_flow * dt / 3600.0
        actual_kg += steam_kg
        if available:
            avail_s += dt
            avail_kg += steam_kg
            rated_kg += OEE_RATED_STEAM_FLOW_KGHR * dt / 3600.0
        if good_steam:
            good_kg += steam_kg
        eff = tags.get("efficiency")
        if eff is not None:
            if eff_start is None:
                eff_start = eff
            eff_end = eff
            eff_min = eff if eff_min is None else min(eff_min, eff)
            eff_max = eff if eff_max is None else max(eff_max, eff)

    planned = max(planned_seconds, 0.0)
    uptime_pct = 100.0 if samples == 0 else 100.0 * (1 - flame_off / samples)
    availability = avail_s / planned if planned > 0 else 0.0
    performance = avail_kg / rated_kg if rated_kg > 0 else 0.0
    quality = good_kg / actual_kg if actual_kg > 0 else 0.0
    availability = max(0.0, min(availability, 1.0))
    performance = max(0.0, min(performance, 1.5))
    quality = max(0.0, min(quality, 1.0))
    hours, rem = divmod(int(planned), 3600)
    minutes = rem // 60

    return {
        "shift_duration": f"{hours}h {minutes:02d}m",
        "uptime_pct": round(uptime_pct, 1),
        "oee_samples": samples,
        "oee": {
            "availability": round(availability, 4),
            "performance": round(performance, 4),
            "quality": round(quality, 4),
            "oee": round(availability * performance * quality, 4),
            "planned_seconds": round(planned, 1),
            "available_seconds": round(avail_s, 1),
            "actual_steam_kg": round(actual_kg, 2),
            "available_steam_kg": round(avail_kg, 2),
            "rated_steam_kg": round(rated_kg, 2),
            "good_steam_kg": round(good_kg, 2),
            "rated_steam_flow_kg_hr": OEE_RATED_STEAM_FLOW_KGHR,
            "good_steam_limits": {
                "pressure_bar": [OEE_MIN_PRESSURE_BAR, OEE_MAX_PRESSURE_BAR],
                "steam_temp_c": [OEE_MIN_STEAM_TEMP_C, OEE_MAX_STEAM_TEMP_C],
                "drum_level_mm": [OEE_MIN_DRUM_LEVEL_MM, OEE_MAX_DRUM_LEVEL_MM],
            },
        },
        "anomaly_events": anomaly_events,
        "alerts": dict(alerts),
        "efficiency": {"start": eff_start, "end": eff_end, "min": eff_min, "max": eff_max},
        "modes_seen": sorted(modes),
    }


def build_shift_narrative(stats):
    """Reason an end-of-shift narrative directly from the computed stats dict."""
    duration = stats.get("shift_duration", "the shift")
    uptime = _as_float(stats.get("uptime_pct"), 0.0)
    anomalies = int(_as_float(stats.get("anomaly_events"), 0))
    alerts = stats.get("alerts", {}) or {}
    crit = int(_as_float(alerts.get("CRITICAL"), 0))
    high = int(_as_float(alerts.get("HIGH"), 0))
    warn = int(_as_float(alerts.get("WARNING"), 0))
    low = int(_as_float(alerts.get("LOW"), 0))
    total_alerts = crit + high + warn + low

    eff = stats.get("efficiency", {}) or {}
    eff_start = eff.get("start")
    eff_end = eff.get("end")
    eff_min = eff.get("min")
    eff_delta = None
    if isinstance(eff_start, (int, float)) and isinstance(eff_end, (int, float)):
        eff_delta = eff_end - eff_start

    modes = stats.get("modes_seen", []) or []
    oee = stats.get("oee", {}) or {}
    oee_pct = _as_float(oee.get("oee"), 0.0) * 100.0

    # ── Overall status: worst-signal-wins ──────────────────────────────────
    if crit > 0 or uptime < 90.0 or (eff_delta is not None and eff_delta < -3.0):
        status = "poor"
    elif (
        anomalies == 0 and high == 0 and uptime >= 99.0
        and (eff_delta is None or eff_delta >= -1.0)
    ):
        status = "good"
    else:
        status = "fair"

    # ── Summary ────────────────────────────────────────────────────────────
    eff_clause = ""
    if eff_end is not None:
        if eff_delta is not None:
            eff_clause = f" Efficiency ended at {eff_end:.1f}% ({eff_delta:+.1f}% vs shift start)."
        else:
            eff_clause = f" Efficiency ended at {eff_end:.1f}%."
    label = stats.get("shift_label")
    lead = (
        f"{label} - {duration} elapsed. BOILER-01 held {uptime:.1f}% flame uptime"
        if label
        else f"Over {duration}, BOILER-01 held {uptime:.1f}% flame uptime"
    )
    summary = (
        f"{lead} with "
        f"{anomalies} anomaly event{'s' if anomalies != 1 else ''} and "
        f"{total_alerts} alert{'s' if total_alerts != 1 else ''} logged.{eff_clause} "
        f"Overall shift status is {status.upper()}."
    )

    # ── Highlights ─────────────────────────────────────────────────────────
    highlights = [f"Flame uptime {uptime:.1f}% across {duration}."]
    if oee.get("oee") is not None:
        highlights.append(
            f"Shift OEE {oee_pct:.1f}% "
            f"(A {_as_float(oee.get('availability'),0)*100:.0f}% x "
            f"P {_as_float(oee.get('performance'),0)*100:.0f}% x "
            f"Q {_as_float(oee.get('quality'),0)*100:.0f}%)."
        )
    if total_alerts:
        parts = []
        if crit: parts.append(f"{crit} critical")
        if high: parts.append(f"{high} high")
        if warn: parts.append(f"{warn} warning")
        if low: parts.append(f"{low} low")
        highlights.append(f"Alerts: {', '.join(parts)}.")
    else:
        highlights.append("No alerts fired this shift.")
    if anomalies:
        highlights.append(f"{anomalies} anomaly event(s) flagged by the AI monitor.")
    if eff_delta is not None and abs(eff_delta) >= 0.1:
        trend = "declined" if eff_delta < 0 else "improved"
        lo = f", low {eff_min:.1f}%" if isinstance(eff_min, (int, float)) else ""
        highlights.append(f"Efficiency {trend} {abs(eff_delta):.1f} pts{lo}.")
    if modes:
        highlights.append(f"Operating modes seen: {', '.join(str(m) for m in modes)}.")

    # ── Follow-ups ─────────────────────────────────────────────────────────
    follow_ups = []
    if crit:
        follow_ups.append("Review the critical alerts before the next shift start-up.")
    if high or warn:
        follow_ups.append("Investigate repeated high/warning alerts for a developing fault.")
    if eff_delta is not None and eff_delta <= -1.0:
        follow_ups.append("Check flue-gas temperature and O2 trim for the efficiency drop.")
    if "FAULT" in [str(m).upper() for m in modes]:
        follow_ups.append("Confirm the boiler fully recovered from the FAULT excursion.")
    if not follow_ups:
        follow_ups.append("No corrective action required; continue routine monitoring.")
        follow_ups.append("Verify feedwater and combustion setpoints at next shift handover.")

    return {
        "summary": summary,
        "overall_status": status,
        "highlights": highlights[:5],
        "follow_ups": follow_ups[:4],
    }


# ============================================================
# AI ANALYST SERVICE
# ============================================================
class AIAnalyst:
    def __init__(self):
        self.telemetry = TelemetryBuffer()
        self.stats = ShiftStats()
        self.memory = IncidentMemory()  # session incident log for pattern correlation
        self.chat_history = deque(maxlen=6)  # last 3 Q&A pairs for follow-up context
        # Use a unique client ID so a second analyst process or restart does not
        # kick the existing session off the broker mid-response.
        client_id = f"nexus_ai_analyst_{uuid.uuid4().hex[:8]}"
        self.mqtt_client = mqtt.Client(client_id=client_id)
        self.last_diagnosis_time = 0
        self.last_anomaly_score = 0

        # ── Autonomous closed-loop controller state ─────────────────────
        # Deterministic policy (no LLM dependency) so the loop closes reliably.
        self.autopilot_engaged = False
        self.fgt_hist = deque(maxlen=12)   # flue gas temp trend
        self.th_hist  = deque(maxlen=12)   # tube health trend
        self.last_control_action = 0

    def on_connect(self, client, userdata, flags, rc):
        if rc == 0:
            print("[AI Analyst] ✓ Connected to MQTT broker")
            client.subscribe(TOPIC_HEARTBEAT)
            client.subscribe(TOPIC_ANOMALY)
            client.subscribe(TOPIC_ALERTS)
            client.subscribe(TOPIC_CHAT_IN)
            print("[AI Analyst] ✓ Subscribed to heartbeat, anomaly, alerts, and chat topics")
            # Publish online status
            client.publish(TOPIC_AI_STATUS, json.dumps({"status": "online"}), qos=1)
            # Warm the Ollama prompt cache in the background so the FIRST operator
            # question is fast (the static system prompt gets pre-processed & cached).
            import threading
            threading.Thread(target=self.warmup_llm, daemon=True).start()
        else:
            print(f"[AI Analyst] ✗ Connection failed: {rc}")

    def warmup_llm(self):
        """
        Prime Ollama's KV cache with the static CHAT_SYSTEM_PROMPT prefix.
        The first LLM call after model load pays the full prompt prefill (slow on
        CPU); doing it here on startup means the operator never waits for it. All
        later chat calls reuse this cached prefix, so the static manual core adds
        ~0 latency. Runs in a daemon thread — failure is non-fatal.
        """
        try:
            call_llm(
                [
                    {"role": "system", "content": CHAT_SYSTEM_PROMPT},
                    {"role": "user", "content": "ready?"},
                ],
                json_mode=False,
                max_tokens=1,
            )
            print("[AI Analyst] LLM warmup complete — system prompt cached")
        except Exception as e:
            print(f"[AI Analyst] ⚠ LLM warmup skipped: {e}")

    def on_message(self, client, userdata, msg):
        try:
            topic = msg.topic
            payload = json.loads(msg.payload.decode())

            if topic == TOPIC_HEARTBEAT:
                self.telemetry.add(payload)
                self.stats.record_reading(payload)
                self.evaluate_autonomous_control(payload)

            elif topic == TOPIC_ANOMALY:
                self.handle_anomaly(payload)

            elif topic == TOPIC_ALERTS:
                self.handle_alert(payload)

            elif topic == TOPIC_CHAT_IN:
                self.handle_chat(payload)

        except Exception as e:
            print(f"[AI Analyst] Message error: {e}")

    # ============================================================
    # AUTONOMOUS CLOSED-LOOP CONTROLLER
    # ============================================================
    def evaluate_autonomous_control(self, payload):
        """
        Deterministic policy that watches the degradation signature and, when it
        develops, autonomously dispatches a corrective control command to the
        engine — genuinely bending the physics, not just annotating a chart.

        Trigger: tube health falling AND flue-gas temp rising while in a
        degrading/critical mode. Re-arms once the boiler is healthy again.
        """
        tags = payload.get("tags", {})
        mode = payload.get("mode", "NORMAL")
        fgt  = tags.get("flue_gas_temp")
        th   = tags.get("tube_health")
        if fgt is None or th is None:
            return

        self.fgt_hist.append(fgt)
        self.th_hist.append(th)

        # Healthy again → stand down so the AI can act on the next event
        if mode == "NORMAL":
            if self.autopilot_engaged:
                print("[AI Analyst] 🤖 Boiler stable — autopilot standing down.")
            self.autopilot_engaged = False
            return

        if self.autopilot_engaged:
            return

        degrading = mode in ("DEGRADING", "CRITICAL")

        # Fouling signature from the recent trend
        signature = False
        if len(self.th_hist) >= 6:
            th_slope  = self.th_hist[-1] - self.th_hist[0]
            fgt_slope = self.fgt_hist[-1] - self.fgt_hist[0]
            signature = (th_slope < -0.5) and (fgt_slope > 2.0)

        # Let degradation visibly develop first, then intervene
        if degrading and (th < 88.0 or fgt > 215.0 or signature):
            self.engage_autopilot(tags)

    def engage_autopilot(self, tags):
        """Dispatch the corrective control command + UI action event."""
        self.autopilot_engaged = True
        self.last_control_action = time.time()
        ts = time.strftime("%H:%M:%S")

        fgt  = tags.get("flue_gas_temp", 0)
        th   = tags.get("tube_health", 0)
        eff  = tags.get("efficiency", 0)
        fuel = tags.get("fuel_flow", 0)

        reason = (f"Tube-fouling signature detected: flue-gas {fgt:.0f}°C rising while "
                  f"tube health {th:.0f}% falls. Trimming excess air, reducing firing "
                  f"rate, and initiating soot blow to arrest the degradation slope.")

        # 1) Engine command bus — this actually changes the physics
        command = {
            "action": "arrest_degradation",
            "autopilot": True,
            "o2_setpoint": 2.8,               # trim excess air → recover efficiency
            "pressure_setpoint": 9.5,         # reduce firing rate → less thermal stress
            "firing_reduction_pct": 12,
            "degradation_rate_factor": 0.33,  # cut fouling accumulation ~67%
            "soot_blow": True,                # one-shot partial UA recovery
            "reason": reason,
            "timestamp": time.time(),
        }
        self.mqtt_client.publish(TOPIC_CONTROL_CMD, json.dumps(command), qos=1)

        # 2) Human-readable action event for the dashboard control console
        action_event = {
            "type": "control_action",
            "headline": "AI Autopilot engaged — arresting tube fouling",
            "timestamp": ts,
            "setpoints": {"o2_percent": 2.8, "steam_pressure_bar": 9.5},
            "firing_reduction_pct": 12,
            "degradation_slope_reduction_pct": 67,
            "soot_blow": True,
            "reason": reason,
            "before": {
                "flue_gas_temp": round(fgt, 1),
                "tube_health": round(th, 1),
                "efficiency": round(eff, 1),
                "fuel_flow": round(fuel, 1),
            },
            "commands": [
                "SET o2_setpoint = 2.8 %",
                "SET steam_pressure_setpoint = 9.5 bar",
                "REDUCE firing_rate -12 %",
                "INITIATE soot_blow",
            ],
        }
        self.mqtt_client.publish(TOPIC_CONTROL_ACTION, json.dumps(action_event), qos=1)
        print(f"[AI Analyst] 🤖 AUTONOMOUS CONTROL — autopilot engaged at {ts}, "
              f"corrective command dispatched to engine.")

    def handle_anomaly(self, payload):
        """Generate diagnosis when anomaly score crosses threshold."""
        score = payload.get("score", 0)
        is_anomaly = payload.get("is_anomaly", False)
        self.last_anomaly_score = score

        if not is_anomaly:
            return

        # Debounce: one diagnosis per event
        now = time.time()
        if now - self.last_diagnosis_time < DIAGNOSIS_COOLDOWN:
            return
        self.last_diagnosis_time = now
        self.stats.record_anomaly()

        print(f"[AI Analyst] 🔍 Anomaly detected (score: {score}%). Generating diagnosis...")
        self.mqtt_client.publish(TOPIC_AI_STATUS, json.dumps({"status": "analyzing"}), qos=1)

        # ── Deterministic pre-analysis ─────────────────────────────────────
        samples = self.telemetry.get_recent_samples(last_n=30)
        brief   = build_physics_brief(samples)
        physics_block = format_brief_for_llm(brief, context="diagnosis")
        safety_ctx = build_safety_context(
            f"Diagnose anomaly: {brief.hypothesis_label}",
            samples,
        )
        safety_block = format_safety_context_for_prompt(safety_ctx)
        print(f"[AI Analyst] 🧮 Deterministic verdict: {brief.hypothesis_label} [{brief.confidence}]")
        if brief.pid_issues:
            for pi in brief.pid_issues:
                print(f"[AI Analyst] 🔧 PID issue [{pi.loop}]: {pi.symptom}")
        # ─────────────────────────────────────────────────────────────────

        # ── Manual notes (keyword-routed, no vector DB) ────────────────────
        manual_block = route_manual(brief.hypothesis_label)
        # ─────────────────────────────────────────────────────────────────

        messages = [
            {
                "role": "system",
                "content": (
                    "You are a boiler maintenance engineer AI for NEXUS OS. "
                    "A deterministic physics engine has already classified the fault — "
                    "your job is to narrate the diagnosis and confirm the corrective actions. "
                    "The SAFETY POLICY LAYER is mandatory: do not include blocked action classes, "
                    "and if evidence is contradictory, say so instead of forcing a single cause. "
                    "Return your response as JSON with: "
                    "\"probable_cause\" (string, use the provided hypothesis label exactly), "
                    "\"severity\" (string: critical/high/warning/low), "
                    "\"explanation\" (string, 2-3 sentences — cite the specific sensor values provided), "
                    "\"recommended_action\" (string, reference the numbered actions provided — add timing/urgency), "
                    "\"confidence\" (number 0-100, use the deterministic confidence level), "
                    "\"pattern_note\" (string or null — cite SESSION HISTORY if this repeats), "
                    "\"deviated_sensors\" (array of objects: sensor, value, baseline, severity — copy from the deviating sensors list)."
                )
            },
            {
                "role": "user",
                "content": (
                    f"Anomaly score: {score}% on BOILER-01.\n\n"
                    f"{physics_block}\n\n"
                    f"{safety_block}\n\n"
                    f"{manual_block}"
                    f"SESSION INCIDENT HISTORY:\n{self.memory.summary()}\n\n"
                    "Return the incident diagnosis as JSON."
                )
            }
        ]

        response = call_llm(messages, json_mode=True)
        if response:
            try:
                diagnosis = json.loads(response)
                # Guarantee the deterministic hypothesis wins even if LLM drifts
                if "probable_cause" not in diagnosis or not diagnosis["probable_cause"]:
                    diagnosis["probable_cause"] = brief.hypothesis_label
                diagnosis, blocked = validate_diagnosis_payload(diagnosis, safety_ctx)
                if blocked:
                    print(f"[AI Analyst] 🛡 Safety policy blocked {len(blocked)} diagnosis item(s)")
                diagnosis["_deterministic_hypothesis"] = brief.primary_hypothesis
                diagnosis["_pid_issues"] = [
                    {"loop": pi.loop, "symptom": pi.symptom, "fix": pi.recommended_action}
                    for pi in brief.pid_issues
                ]
                self.mqtt_client.publish(TOPIC_DIAGNOSIS, json.dumps(diagnosis), qos=1)
                self.memory.record_diagnosis(diagnosis)
                print(f"[AI Analyst] ✅ Diagnosis published: {diagnosis.get('probable_cause', '?')}")
            except json.JSONDecodeError:
                print(f"[AI Analyst] ⚠ Non-JSON response from AI: {response[:100]}")
        else:
            # Fallback: publish deterministic-only diagnosis without LLM narrative
            fallback = {
                "probable_cause": brief.hypothesis_label,
                "severity": brief.confidence.lower(),
                "explanation": (
                    f"Deterministic analysis identified {brief.hypothesis_label}. "
                    f"Deviating sensors: {', '.join(d.sensor for d in brief.deviating_sensors[:3])}."
                ),
                "recommended_action": " | ".join(brief.corrective_actions[:2]),
                "confidence": 80 if brief.confidence == "HIGH" else 50,
                "pattern_note": None,
                "deviated_sensors": [
                    {"sensor": d.sensor, "value": d.value,
                     "baseline": d.baseline, "severity": d.severity}
                    for d in brief.deviating_sensors[:5]
                ],
                "_deterministic_hypothesis": brief.primary_hypothesis,
                "_pid_issues": [
                    {"loop": pi.loop, "symptom": pi.symptom, "fix": pi.recommended_action}
                    for pi in brief.pid_issues
                ],
                "_llm_unavailable": True,
            }
            fallback, blocked = validate_diagnosis_payload(fallback, safety_ctx)
            if blocked:
                print(f"[AI Analyst] 🛡 Safety policy blocked {len(blocked)} fallback item(s)")
            self.mqtt_client.publish(TOPIC_DIAGNOSIS, json.dumps(fallback), qos=1)
            self.memory.record_diagnosis(fallback)
            print("[AI Analyst] ⚠ LLM unavailable — deterministic-only diagnosis published")

        # Reset status
        self.mqtt_client.publish(TOPIC_AI_STATUS, json.dumps({"status": "online"}), qos=1)

    def handle_alert(self, payload):
        """Generate diagnosis when critical alerts fire."""
        severity = payload.get("severity", "")
        self.stats.record_alert(severity)
        self.memory.record_alert(payload)
        if severity not in ("CRITICAL", "HIGH"):
            return

        # Debounce
        now = time.time()
        if now - self.last_diagnosis_time < DIAGNOSIS_COOLDOWN:
            return
        self.last_diagnosis_time = now

        print(f"[AI Analyst] 🚨 Alert [{severity}]: {payload.get('message','')}. Generating diagnosis...")
        self.mqtt_client.publish(TOPIC_AI_STATUS, json.dumps({"status": "analyzing"}), qos=1)

        # ── Deterministic pre-analysis ─────────────────────────────────────
        samples = self.telemetry.get_recent_samples(last_n=30)
        brief   = build_physics_brief(samples)
        physics_block = format_brief_for_llm(brief, context="diagnosis")
        safety_ctx = build_safety_context(
            f"Diagnose alert {payload.get('tag','')}: {payload.get('message','')}",
            samples,
        )
        safety_block = format_safety_context_for_prompt(safety_ctx)
        print(f"[AI Analyst] 🧮 Deterministic verdict: {brief.hypothesis_label} [{brief.confidence}]")
        if brief.pid_issues:
            for pi in brief.pid_issues:
                print(f"[AI Analyst] 🔧 PID issue [{pi.loop}]: {pi.symptom}")
        # ─────────────────────────────────────────────────────────────────

        # ── Manual notes (keyword-routed, no vector DB) ────────────────────
        manual_block = route_manual(f"{payload.get('tag','')} {brief.hypothesis_label}")
        # ─────────────────────────────────────────────────────────────────

        messages = [
            {
                "role": "system",
                "content": (
                    "You are a boiler maintenance engineer AI for NEXUS OS. "
                    "A deterministic physics engine has classified the fault — your job is to "
                    "confirm, explain, and prioritise the corrective actions based on the alert context. "
                    "The SAFETY POLICY LAYER is mandatory: do not include blocked action classes, "
                    "and if evidence is contradictory, say so instead of forcing a single cause. "
                    "When BOILER MANUAL EXCERPTS are provided, cite them. "
                    "Cross-reference SESSION INCIDENT HISTORY: if this alert repeats, flag it in pattern_note. "
                    "Return JSON with: probable_cause, severity (critical/high/warning/low), "
                    "explanation (2-3 sentences with actual sensor values), "
                    "recommended_action (prioritised steps with urgency/timing), "
                    "confidence (0-100), pattern_note (string or null), "
                    "deviated_sensors (array: sensor, value, baseline, severity)."
                )
            },
            {
                "role": "user",
                "content": (
                    f"ALERT FIRED on BOILER-01:\n"
                    f"  Severity : {severity}\n"
                    f"  Message  : {payload.get('message','')}\n"
                    f"  Tag      : {payload.get('tag','')} = {payload.get('value','')} "
                    f"(threshold {payload.get('threshold','?')})\n\n"
                    f"{physics_block}\n\n"
                    f"{safety_block}\n\n"
                    f"{manual_block}"
                    f"SESSION INCIDENT HISTORY:\n{self.memory.summary()}\n\n"
                    "Return the incident diagnosis as JSON."
                )
            }
        ]

        response = call_llm(messages, json_mode=True)
        if response:
            try:
                diagnosis = json.loads(response)
                if "probable_cause" not in diagnosis or not diagnosis["probable_cause"]:
                    diagnosis["probable_cause"] = brief.hypothesis_label
                diagnosis, blocked = validate_diagnosis_payload(diagnosis, safety_ctx)
                if blocked:
                    print(f"[AI Analyst] 🛡 Safety policy blocked {len(blocked)} alert diagnosis item(s)")
                diagnosis["_deterministic_hypothesis"] = brief.primary_hypothesis
                diagnosis["_pid_issues"] = [
                    {"loop": pi.loop, "symptom": pi.symptom, "fix": pi.recommended_action}
                    for pi in brief.pid_issues
                ]
                self.mqtt_client.publish(TOPIC_DIAGNOSIS, json.dumps(diagnosis), qos=1)
                self.memory.record_diagnosis(diagnosis)
                print(f"[AI Analyst] ✅ Diagnosis published: {diagnosis.get('probable_cause', '?')}")
            except json.JSONDecodeError:
                print(f"[AI Analyst] ⚠ Non-JSON response: {response[:100]}")
        else:
            # Fallback: publish deterministic-only diagnosis
            fallback = {
                "probable_cause": brief.hypothesis_label,
                "severity": severity.lower(),
                "explanation": (
                    f"Alert fired: {payload.get('message','')}. "
                    f"Deterministic analysis confirms {brief.hypothesis_label}. "
                    f"Key deviations: {', '.join(str(d) for d in brief.deviating_sensors[:2])}."
                ),
                "recommended_action": " | ".join(brief.corrective_actions[:2]),
                "confidence": 80 if brief.confidence == "HIGH" else 50,
                "pattern_note": None,
                "deviated_sensors": [
                    {"sensor": d.sensor, "value": d.value,
                     "baseline": d.baseline, "severity": d.severity}
                    for d in brief.deviating_sensors[:5]
                ],
                "_deterministic_hypothesis": brief.primary_hypothesis,
                "_pid_issues": [
                    {"loop": pi.loop, "symptom": pi.symptom, "fix": pi.recommended_action}
                    for pi in brief.pid_issues
                ],
                "_llm_unavailable": True,
            }
            fallback, blocked = validate_diagnosis_payload(fallback, safety_ctx)
            if blocked:
                print(f"[AI Analyst] 🛡 Safety policy blocked {len(blocked)} alert fallback item(s)")
            self.mqtt_client.publish(TOPIC_DIAGNOSIS, json.dumps(fallback), qos=1)
            self.memory.record_diagnosis(fallback)
            print("[AI Analyst] ⚠ LLM unavailable — deterministic-only diagnosis published")

        self.mqtt_client.publish(TOPIC_AI_STATUS, json.dumps({"status": "online"}), qos=1)

    # --------------------------------------------------------
    # INTENT ROUTER  (LLM-as-classifier — replaces brittle keyword lists)
    # --------------------------------------------------------
    # When the operator names a sensor, decide what they actually want. This is
    # the same LLM-classifier pattern as the domain guardrail below, so no extra
    # framework (CrewAI/LangGraph/etc.) is needed — the local Ollama model does it.
    # It generalises past hardcoded words: "why", "what's driving it", "is that a
    # problem", "break it down" all resolve to REASON without a keyword list.
    _INTENT_ROUTER_PROMPT = (
        "You route an operator's question about a single boiler sensor to one "
        "handler. Reply with EXACTLY one word: VALUE, HISTORY, or REASON.\n\n"
        "VALUE   = wants the current live reading and/or whether it is normal "
        "right now. e.g. 'what is the drum level', 'drum level now', "
        "'is the drum level ok', 'current steam pressure and is it fine'.\n"
        "HISTORY = wants a past value, trend, average, min/max, or comparison "
        "over time. e.g. 'drum level yesterday', 'average O2 last shift', "
        "'highest flue gas temp this week'.\n"
        "REASON  = wants an explanation, cause, diagnosis, recommendation, "
        "prediction, or what-if. ANY phrasing that asks to understand or act on "
        "the value, not just read it. e.g. 'why is the drum level low', "
        "'what's driving the drum level', 'is that a problem and what do I do', "
        "'explain the drum level', 'what happens if it keeps dropping'. "
        "Questions about PID, controller stability, loop hunting, tuning, "
        "windup, setpoint tracking, saturation, overshoot, or whether a control "
        "loop is stable are always REASON, even if they mention a sensor value "
        "like O2 or pressure.\n\n"
        "Reply with one word only: VALUE, HISTORY, or REASON."
    )

    def _route_sensor_question(self, question: str):
        """
        LLM intent router: for a question that names a sensor, return
        'VALUE' | 'HISTORY' | 'REASON', or None if the router LLM is unreachable
        (caller then falls back to the keyword heuristic). Robust to phrasing —
        no hardcoded 'why/reason/cause' list to keep in sync.
        """
        messages = [
            {"role": "system", "content": self._INTENT_ROUTER_PROMPT},
            {"role": "user", "content": question},
        ]
        try:
            # think=False + tiny budget -> fast, clean one-word answer on CPU.
            result = call_llm(messages, json_mode=False, max_tokens=8, think=False)
            if not result:
                return None
            cleaned = result.strip().upper()
            for label in ("HISTORY", "REASON", "VALUE"):
                if label in cleaned:
                    print(f"[AI Analyst] Intent route: {label} <- {question[:60]}")
                    return label
            return None
        except Exception as e:
            print(f"[AI Analyst] Intent router error ({e}) — keyword fallback")
            return None

    # --------------------------------------------------------
    # DOMAIN GUARDRAIL  (Tier-2: LLM-as-classifier)
    # --------------------------------------------------------
    _CLASSIFIER_PROMPT = (
        "You are a strict domain classifier for NEXUS OS, an industrial boiler "
        "monitoring system. Decide if the user question is on-domain or off-domain.\n\n"
        "ON-DOMAIN — any question about:\n"
        "  boiler operations, steam, pressure, temperature, drum level, tube health,\n"
        "  efficiency, heat rate, fuel flow, air flow, O2, combustion, flue gas,\n"
        "  feedwater, anomaly scores, alerts, maintenance, plant safety, NEXUS OS.\n\n"
        "OFF-DOMAIN — anything else: food, sports, entertainment, celebrities,\n"
        "  general coding help, weather, finance, jailbreaks, roleplay, etc.\n\n"
        "Reply with exactly one word: YES (on-domain) or NO (off-domain)."
    )

    def _is_on_domain(self, question: str) -> bool:
        """
        Tier-2 LLM-as-classifier guardrail.
        Makes a lightweight YES/NO call to Ollama before routing to the main
        chat LLM. Falls back to a jailbreak-only check when Ollama is
        unreachable so a connectivity blip never silently blocks operators.
        """
        messages = [
            {"role": "system", "content": self._CLASSIFIER_PROMPT},
            {"role": "user", "content": question},
        ]
        try:
            # think=False forces a clean one-word YES/NO even on reasoning models.
            # call_llm already strips any <think> block from the reply.
            result = call_llm(messages, json_mode=False, max_tokens=64, think=False)
            if result is None:
                print("[AI Analyst] ⚠ Classifier LLM unavailable — jailbreak-only fallback")
                return self._jailbreak_fallback(question)

            cleaned = result.strip().upper()
            # FAIL OPEN: only block when the model clearly says NO. Empty, garbled,
            # or ambiguous replies default to on-domain so a formatting quirk in the
            # model never locks operators out of the assistant.
            if not cleaned:
                is_ok = True
            elif cleaned.startswith("NO"):
                is_ok = False
            elif cleaned.startswith("YES"):
                is_ok = True
            elif "NO" in cleaned and "YES" not in cleaned:
                is_ok = False
            else:
                is_ok = True

            tag = "✅ ON-DOMAIN" if is_ok else "🚫 OFF-DOMAIN"
            print(f"[AI Analyst] {tag}: {question[:70]}")
            return is_ok
        except Exception as e:
            print(f"[AI Analyst] ⚠ Classifier error ({e}) — jailbreak-only fallback")
            return self._jailbreak_fallback(question)

    @staticmethod
    def _jailbreak_fallback(question: str) -> bool:
        """
        Last-resort check used only when the classifier LLM is unreachable.
        Blocks obvious jailbreak attempts; allows everything else so a
        connectivity blip never silently locks out legitimate operator queries.
        """
        q = question.lower()
        JAILBREAKS = [
            "ignore previous", "ignore your", "forget your",
            "pretend you", "pretend to be", "act as", "you are now",
            "override your", "new instructions", "disregard",
        ]
        return not any(j in q for j in JAILBREAKS)

    def handle_chat(self, payload):
        """Handle user chat questions — 'Ask the Plant' feature."""
        # Shift report requests arrive on the same topic with a type marker
        if payload.get("type") == "shift_report":
            self.handle_shift_report()
            return

        question = payload.get("question", "").strip()
        if not question:
            return

        latest_samples = self.telemetry.get_recent_samples(last_n=1)
        latest_reading = latest_samples[-1] if latest_samples else None

        # ── Intent routing (LLM-as-classifier, not keyword matching) ──────────
        # Only serve the fast deterministic value read-out when the operator
        # actually wants the VALUE. If they ask WHY / for a cause / diagnosis —
        # in any phrasing — the router sends it (REASON/HISTORY) down to the LLM
        # instead of returning the canned reading. Keyword heuristic is used only
        # when the router LLM is unreachable, so a connectivity blip still works.
        current_value_answer = None
        tag = _find_requested_tag(question)
        if tag:
            route = "REASON" if _is_control_loop_question(question) else self._route_sensor_question(question)
            if route == "VALUE":
                current_value_answer = build_current_value_answer(
                    question, latest_reading, force=True
                )
            elif route is None:
                # Router LLM down — fall back to the keyword heuristic.
                current_value_answer = build_current_value_answer(question, latest_reading)
            # route in ("REASON", "HISTORY") -> leave None, fall through to LLM/historian
        if current_value_answer:
            print(f"[AI Analyst] Deterministic value answer: {question[:70]}")
            self.chat_history.append({"role": "user", "content": question})
            self.chat_history.append({"role": "assistant", "content": current_value_answer})
            self.mqtt_client.publish(TOPIC_CHAT_OUT, json.dumps({
                "answer": current_value_answer,
                "timestamp": time.time(),
            }), qos=1)
            self.mqtt_client.publish(TOPIC_AI_STATUS, json.dumps({"status": "online"}), qos=1)
            return

        oee_answer = build_oee_answer(question, self.stats.snapshot())
        if oee_answer:
            print(f"[AI Analyst] OEE calculation answer: {question[:70]}")
            self.chat_history.append({"role": "user", "content": question})
            self.chat_history.append({"role": "assistant", "content": oee_answer})
            self.mqtt_client.publish(TOPIC_CHAT_OUT, json.dumps({
                "answer": oee_answer,
                "timestamp": time.time()
            }), qos=1)
            self.mqtt_client.publish(TOPIC_AI_STATUS, json.dumps({"status": "online"}), qos=1)
            return

        # ── GUARDRAIL: reject off-topic questions immediately ──────────────
        if not self._is_on_domain(question):
            print(f"[AI Analyst] 🚫 Off-topic question blocked: {question[:80]}")
            self.mqtt_client.publish(TOPIC_CHAT_OUT, json.dumps({
                "answer": (
                    "I'm NEXUS OS — a specialist AI for BOILER-01 operations and "
                    "telemetry analysis. I can only answer questions related to "
                    "boiler performance, sensor readings, faults, maintenance, "
                    "or plant safety. Please ask me something about the boiler."
                ),
                "timestamp": time.time()
            }), qos=1)
            self.mqtt_client.publish(TOPIC_AI_STATUS, json.dumps({"status": "online"}), qos=1)
            return
        # ──────────────────────────────────────────────────────────────────

        # "What-if" scenarios get the dedicated step-by-step simulator
        if payload.get("type") == "what_if" or "what if" in question.lower()[:40]:
            self.handle_what_if(question)
            return

        print(f"[AI Analyst] 💬 Chat question: {question}")
        self.mqtt_client.publish(TOPIC_AI_STATUS, json.dumps({"status": "analyzing"}), qos=1)

        # Maintenance-priority questions return a structured card payload
        # (dict); historical metric questions return a plain string.
        maintenance_answer = None
        if answer_maintenance_priority_question is not None:
            maintenance_answer = answer_maintenance_priority_question(question)
        if maintenance_answer:
            payload = dict(maintenance_answer)
            payload["timestamp"] = time.time()
            self.chat_history.append({"role": "user", "content": question})
            self.chat_history.append({"role": "assistant", "content": maintenance_answer.get("answer", "")})
            self.mqtt_client.publish(TOPIC_CHAT_OUT, json.dumps(payload), qos=1)
            self.mqtt_client.publish(TOPIC_AI_STATUS, json.dumps({"status": "online"}), qos=1)
            print("[AI Analyst] 🧰 Maintenance priorities card published")
            return

        deterministic_answer = None
        if answer_historical_metric_question is not None:
            deterministic_answer = answer_historical_metric_question(question)
        if deterministic_answer:
            self.chat_history.append({"role": "user", "content": question})
            self.chat_history.append({"role": "assistant", "content": deterministic_answer})
            self.mqtt_client.publish(TOPIC_CHAT_OUT, json.dumps({
                "answer": deterministic_answer,
                "timestamp": time.time()
            }), qos=1)
            self.mqtt_client.publish(TOPIC_AI_STATUS, json.dumps({"status": "online"}), qos=1)
            return

        # ── Deterministic pre-analysis ─────────────────────────────────────
        samples = self.telemetry.get_recent_samples(last_n=30)
        brief   = build_physics_brief(samples)
        safety_ctx = build_safety_context(question, samples)
        safety_block = format_safety_context_for_prompt(safety_ctx)

        # Detect if question is efficiency-focused for richer context injection
        q_lower = question.lower()
        is_efficiency_q = any(kw in q_lower for kw in [
            "efficiency", "heat rate", "fuel", "stack loss", "flue gas", "tube"
        ])
        is_level_q = any(kw in q_lower for kw in [
            "drum", "level", "feedwater", "water"
        ])
        is_combustion_q = any(kw in q_lower for kw in [
            "o2", "oxygen", "air", "combustion", "flame", "burner"
        ])
        is_pressure_q = any(kw in q_lower for kw in [
            "pressure", "steam", "safety valve", "trip"
        ])

        chat_context = "efficiency" if is_efficiency_q else "chat"
        physics_block = format_brief_for_llm(brief, context=chat_context)
        control_loop_block = build_control_loop_context(question, samples, brief)
        print(f"[AI Analyst] 🧮 Deterministic context: {brief.hypothesis_label} [{brief.confidence}]")
        # ─────────────────────────────────────────────────────────────────

        # ── Manual notes (keyword-routed, no vector DB) ────────────────────
        manual_block = route_manual(question)
        # ─────────────────────────────────────────────────────────────────

        historian_block = ""
        if build_historian_context is not None:
            historian_block = build_historian_context(question)
            if historian_block:
                print("[AI Analyst] 📚 Historian context attached")

        messages = [
            {"role": "system", "content": CHAT_SYSTEM_PROMPT}
        ]
        # Inject recent conversation for follow-up resolution
        messages.extend(self.chat_history)
        messages.append({
            "role": "user",
            "content": (
                f"{physics_block}\n\n"
                f"{control_loop_block}"
                f"{safety_block}\n\n"
                f"{historian_block}"
                f"{manual_block}"
                f"SESSION INCIDENT HISTORY:\n{self.memory.summary()}\n\n"
                f"OPERATOR QUESTION: {question}"
            )
        })

        response = call_llm(messages, json_mode=False, max_tokens=250)
        if response:
            response, blocked = validate_llm_text(response, safety_ctx)
            if blocked:
                print(f"[AI Analyst] 🛡 Safety policy blocked {len(blocked)} chat item(s)")
            self.chat_history.append({"role": "user", "content": question})
            self.chat_history.append({"role": "assistant", "content": response})
            chat_response = {
                "answer": response,
                "timestamp": time.time()
            }
            info = self.mqtt_client.publish(TOPIC_CHAT_OUT, json.dumps(chat_response), qos=1)
            info.wait_for_publish(timeout=2)
            print(f"[AI Analyst] ✅ Chat response sent")
        else:
            error_response = {
                "answer": "I'm unable to reach the AI service right now. Please check the Ollama server and network connection.",
                "timestamp": time.time()
            }
            self.mqtt_client.publish(TOPIC_CHAT_OUT, json.dumps(error_response), qos=1)

        self.mqtt_client.publish(TOPIC_AI_STATUS, json.dumps({"status": "online"}), qos=1)

    def handle_what_if(self, question):
        """What-If Simulator — walk through the physical consequence chain of a hypothetical."""
        print(f"[AI Analyst] 🧪 What-if scenario: {question}")
        self.mqtt_client.publish(TOPIC_AI_STATUS, json.dumps({"status": "analyzing"}), qos=1)

        latest = self.telemetry.get_latest_summary()
        trend = self.telemetry.get_context(last_n=30)

        # ── Manual notes (keyword-routed, no vector DB) ─────────────────────
        manual_block = route_manual(question)
        # ────────────────────────────────────────────────────────────────────

        messages = [
            {
                "role": "system",
                "content": (
                    "You are a boiler physics simulation expert for NEXUS OS, monitoring BOILER-01, an "
                    "industrial fire-tube boiler. An operator poses a hypothetical scenario. Starting from "
                    "the CURRENT live state provided, walk through the physical consequence chain "
                    "step-by-step, citing real thermodynamics and these protection thresholds:\n"
                    "- Drum level: 400mm setpoint | LOW alarm <280mm | CRITICAL <200mm (dry-firing risk, "
                    "tube rupture hazard)\n"
                    "- Steam pressure: 10 bar setpoint | HIGH alarm >13 bar | safety valve lifts at 13.5 bar\n"
                    "- Flue gas temp: ~198°C normal | HIGH alarm >240°C (tube fouling indicator)\n"
                    "- O2: 2-4% optimal band | >5.5% excess air alarm | <2% incomplete combustion / CO risk\n"
                    "- Tube health: <70% requires inspection | Steam temp follows saturation curve + 5°C superheat\n\n"
                    "Be quantitative — reference the actual current sensor values as the starting point and "
                    "estimate magnitudes/timescales where physics allows. Do not invent sensors that don't exist.\n\n"
                    "Return strict JSON:\n"
                    "{\n"
                    '  "scenario": "short restatement of the hypothetical",\n'
                    '  "risk_level": "low|medium|high|critical",\n'
                    '  "summary": "1-2 sentence overall assessment",\n'
                    '  "steps": [{"step": 1, "event": "what happens", "consequence": "physical effect, with values/thresholds"}],\n'
                    '  "operator_actions": ["2-4 specific preventive/corrective actions"]\n'
                    "}\n"
                    "Use 3-6 steps, ordered as the causal chain would actually unfold."
                )
            },
            {
                "role": "user",
                "content": (
                    f"{manual_block}"
                    f"CURRENT BOILER STATE:\n{latest}\n\n"
                    f"RECENT TELEMETRY (last 30 seconds):\n{trend}\n\n"
                    f"OPERATOR HYPOTHETICAL: {question}\n\n"
                    "Simulate the consequence chain and return JSON."
                )
            }
        ]

        response = call_llm(messages, json_mode=True, max_tokens=900)
        if response:
            # The model often ignores the schema or wraps JSON in ```fences```.
            # Coerce/normalize into the WhatIfCard schema so the dashboard can
            # render a card instead of dumping raw JSON at the operator.
            sim = normalize_what_if(_coerce_json_object(response))
            if sim:
                sim["type"] = "what_if"
                sim["timestamp"] = time.time()
                self.mqtt_client.publish(TOPIC_CHAT_OUT, json.dumps(sim), qos=1)
                # Keep a condensed record so follow-up chat questions can reference it
                self.chat_history.append({"role": "user", "content": question})
                self.chat_history.append({
                    "role": "assistant",
                    "content": f"[What-if simulation] {sim.get('summary', '')} "
                               f"Risk level: {sim.get('risk_level', '?')}."
                })
                print(f"[AI Analyst] What-if simulation published (risk: {sim.get('risk_level','?')})")
            else:
                # Unparseable / unsalvageable — send readable text, never raw JSON.
                raw = _coerce_json_object(response)
                fallback_text = _stringify_json_value(raw) if raw is not None else response.strip()
                print(f"[AI Analyst] What-if response did not match schema — text fallback")
                self.mqtt_client.publish(TOPIC_CHAT_OUT, json.dumps({
                    "answer": fallback_text, "timestamp": time.time()
                }), qos=1)
        else:
            self.mqtt_client.publish(TOPIC_CHAT_OUT, json.dumps({
                "answer": "I couldn't run the what-if simulation — the AI service is unreachable.",
                "timestamp": time.time()
            }), qos=1)

        self.mqtt_client.publish(TOPIC_AI_STATUS, json.dumps({"status": "online"}), qos=1)

    def _resolve_shift_stats(self):
        """
        Build the shift snapshot for the CURRENT fixed 8h clock shift.
        Prefers the historian (true full-shift window, survives restarts); falls
        back to the in-memory since-boot stats when no historian data is present.
        Returns (stats, shift_start, shift_end, shift_label, data_source).
        """
        now_local = datetime.now().astimezone()
        shift_start, shift_end, shift_label = current_shift_window(now_local)
        window_end = min(now_local, shift_end)
        planned_seconds = (window_end - shift_start).total_seconds()

        if fetch_telemetry_window is not None and count_events_window is not None:
            try:
                rows = fetch_telemetry_window(shift_start, window_end)
                if rows:
                    events = count_events_window(shift_start, window_end)
                    stats = compute_shift_stats_from_rows(
                        rows, planned_seconds, events["alerts"], events["anomaly_episodes"]
                    )
                    print(f"[AI Analyst] Shift stats from historian: {len(rows)} samples "
                          f"over {shift_label}")
                    return stats, shift_start, shift_end, shift_label, "historian"
            except Exception as e:
                print(f"[AI Analyst] Historian shift query failed ({e}) — using in-memory stats")

        # Fallback: in-memory accumulators since the analyst started.
        stats = self.stats.snapshot()
        print(f"[AI Analyst] Shift stats from in-memory (analyst uptime) for {shift_label}")
        return stats, shift_start, shift_end, shift_label, "in_memory"

    def handle_shift_report(self):
        """Generate an end-of-shift summary report for the current 8h shift."""
        print("[AI Analyst] Shift report requested. Generating...")
        self.mqtt_client.publish(TOPIC_AI_STATUS, json.dumps({"status": "analyzing"}), qos=1)

        stats, shift_start, shift_end, shift_label, data_source = self._resolve_shift_stats()
        stats["shift_label"] = shift_label
        stats["shift_start"] = shift_start.isoformat()
        stats["shift_end"] = shift_end.isoformat()
        stats["data_source"] = data_source
        latest = self.telemetry.get_latest_summary()
        trend = self.telemetry.get_context(last_n=60)

        messages = [
            {
                "role": "system",
                "content": (
                    "You are a boiler operations supervisor AI for NEXUS OS writing an end-of-shift report for BOILER-01. "
                    "The report covers ONE fixed 8-hour operating shift (the shift_label/window in the statistics), not the whole day. "
                    "You are given hard shift statistics (computed locally — treat them as ground truth) plus current "
                    "readings and a recent trend window. Reference the shift by its label. Return strict JSON with these fields: "
                    "\"summary\" (string, 1-2 sentence narrative of the shift), "
                    "\"overall_status\" (string: good/fair/poor), "
                    "\"highlights\" (array of 3-5 short strings: notable events, trends, or confirmations of stability), "
                    "\"follow_ups\" (array of 2-4 short strings: specific recommended actions for the next shift). "
                    "Cite specific sensor values where relevant. Do not invent events not supported by the data."
                )
            },
            {
                "role": "user",
                "content": (
                    f"SHIFT: {shift_label} (source: {data_source})\n\n"
                    f"SHIFT STATISTICS:\n{json.dumps(stats, indent=2)}\n\n"
                    f"CURRENT READINGS:\n{latest}\n\n"
                    f"RECENT TREND (last 60 seconds):\n{trend}\n\n"
                    "Write the end-of-shift report as JSON."
                )
            }
        ]

        # Reasoning models (qwen3.5 is the current default) are verbose, so give
        # the JSON enough room to finish — a 600-token cap truncated it mid-object
        # and the narrative failed to parse. think=False keeps reasoning out of the
        # token budget so the whole allowance goes to the JSON answer.
        response = call_llm(messages, json_mode=True, max_tokens=1200, think=False)
        report = dict(stats)
        report["type"] = "shift_report"
        report["timestamp"] = time.time()

        # Deterministic narrative reasoned straight from the stats — always valid.
        # The LLM narrative layers on top of it when (and only when) it parses.
        narrative = build_shift_narrative(stats)

        llm_fields = _coerce_json_object(response) if response else None
        if isinstance(llm_fields, dict):
            for key in ("summary", "overall_status", "highlights", "follow_ups"):
                val = llm_fields.get(key)
                if val:  # only override when the model actually produced content
                    narrative[key] = val
            print("[AI Analyst] Shift report narrative parsed from LLM")
        elif response is None:
            print("[AI Analyst] LLM unreachable — deterministic shift narrative used")
        else:
            print(f"[AI Analyst] Non-JSON shift report — deterministic narrative used: {str(response)[:80]}")

        for key in ("summary", "overall_status", "highlights", "follow_ups"):
            report[key] = narrative[key]

        self.mqtt_client.publish(TOPIC_CHAT_OUT, json.dumps(report), qos=1)
        print("[AI Analyst] Shift report published")
        self.mqtt_client.publish(TOPIC_AI_STATUS, json.dumps({"status": "online"}), qos=1)

    def run(self):
        print("=" * 60)
        print("  NEXUS OS — AI Analyst Service")
        print(f"  Backend: OLLAMA")
        print(f"  Model  : {OLLAMA_MODEL}")
        print(f"  Broker : {BROKER}:{PORT}")
        print(f"  Ollama : {OLLAMA_BASE_URL}")
        print("=" * 60)

        self.mqtt_client.on_connect = self.on_connect
        self.mqtt_client.on_message = self.on_message
        self.mqtt_client.connect(BROKER, PORT, 60)
        self.mqtt_client.loop_forever()


if __name__ == "__main__":
    analyst = AIAnalyst()
    analyst.run()
