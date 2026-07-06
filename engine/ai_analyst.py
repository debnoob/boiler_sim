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
        _parse_explicit_date as historian_parse_explicit_date,
    )
except Exception:
    answer_historical_metric_question = None
    answer_maintenance_priority_question = None
    build_historian_context = None
    fetch_telemetry_window = None
    count_events_window = None
    historian_parse_explicit_date = None

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

# Groq is used only for lightweight routing/classification decisions. Final
# operator answers still come from the local Ollama model.
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
GROQ_ROUTER_MODEL = os.environ.get("GROQ_ROUTER_MODEL", "qwen/qwen3.6-27b")
GROQ_CHAT_URL = os.environ.get("GROQ_CHAT_URL", "https://api.groq.com/openai/v1/chat/completions")

# MQTT Topics
TOPIC_HEARTBEAT = "factory/pumphouse4/boiler/unit01/system/heartbeat"
TOPIC_ANOMALY = "factory/pumphouse4/boiler/unit01/ai/anomaly_score"
TOPIC_ALERTS = "factory/pumphouse4/boiler/unit01/alerts"
TOPIC_CHAT_IN = "factory/pumphouse4/boiler/unit01/ai/question"
TOPIC_CHAT_OUT = "factory/pumphouse4/boiler/unit01/ai/response"
TOPIC_DIAGNOSIS = "factory/pumphouse4/boiler/unit01/ai/diagnosis"
TOPIC_AI_STATUS = "factory/pumphouse4/boiler/unit01/ai/status"
TOPIC_OEE = "factory/pumphouse4/boiler/unit01/kpi/oee"
TOPIC_OEE_REQUEST = "factory/pumphouse4/boiler/unit01/kpi/oee/request"
TOPIC_OEE_HISTORY = "factory/pumphouse4/boiler/unit01/kpi/oee/history"

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
OEE_RATED_EFFICIENCY_PCT = BASELINES["efficiency"]
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


def _clamp(value, lo=0.0, hi=1.0):
    return max(lo, min(hi, value))


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
        "OEE for this boiler is calculated as a boiler energy-effectiveness score:\n"
        "- Availability = available boiler time / planned boiler time\n"
        f"- Performance = average thermal efficiency / rated efficiency ({OEE_RATED_EFFICIENCY_PCT:.1f}%)\n"
        "- Quality = good steam mass / available steam mass\n"
        "- OEE = Availability x Performance x Quality\n\n"
        "For BOILER-01, good steam means flame proven, no safety-valve lift, not in FAULT mode, "
        f"pressure {OEE_MIN_PRESSURE_BAR:.1f}-{OEE_MAX_PRESSURE_BAR:.1f} bar, "
        f"steam temperature {OEE_MIN_STEAM_TEMP_C:.0f}-{OEE_MAX_STEAM_TEMP_C:.0f} °C, and "
        f"drum level {OEE_MIN_DRUM_LEVEL_MM:.0f}-{OEE_MAX_DRUM_LEVEL_MM:.0f} mm. "
        f"Steam throughput versus {OEE_RATED_STEAM_FLOW_KGHR:.0f} kg/hr is tracked as load utilization, "
        "but it is not used as the performance factor."
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
    bad_steam_kg = max(0.0, available_steam_kg - good_steam_kg)
    avg_efficiency = oee.get("avg_efficiency_pct", 0.0)
    rated_efficiency = oee.get("rated_efficiency_pct", OEE_RATED_EFFICIENCY_PCT)
    load_utilization = oee.get("load_utilization", 0.0)
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
                f"Calculation: **{avg_efficiency:.2f}% average thermal efficiency / {rated_efficiency:.1f}% rated efficiency**. "
                f"Steam load utilization is **{_pct(load_utilization)}**, tracked separately from OEE performance."
            )
        return f"Performance is **{_pct(performance)}** for this shift window."

    if ("quality" in q or "good steam" in q or "defective steam" in q or "bad steam" in q) and "oee" not in q:
        if show_working:
            return (
                f"Quality is **{_pct(quality)}** for this shift window. "
                f"Calculation: **{_kg(good_steam_kg)} good steam / {_kg(available_steam_kg)} available steam**. "
                f"Estimated out-of-spec steam is **{_kg(bad_steam_kg)}**. "
                "Good steam requires pressure, temperature, drum level, flame, safety valve, and mode to be inside the BOILER-01 limits."
            )
        return f"Quality is **{_pct(quality)}** for this shift window."

    if not show_working:
        return (
            f"Current shift OEE is **{_pct(overall)}**. "
            f"Availability is **{_pct(availability)}**, thermal performance is **{_pct(performance)}**, "
            f"and quality is **{_pct(quality)}**."
        )

    return (
        f"Current shift OEE is **{_pct(overall)}**.\n"
        f"- Availability: **{_pct(availability)}** = {available_seconds:.0f} s / {planned_seconds:.0f} s\n"
        f"- Performance: **{_pct(performance)}** = {avg_efficiency:.2f}% average efficiency / {rated_efficiency:.1f}% rated efficiency\n"
        f"- Quality: **{_pct(quality)}** = {_kg(good_steam_kg)} / {_kg(available_steam_kg)} available steam\n"
        f"- OEE: **{_pct(availability)} x {_pct(performance)} x {_pct(quality)} = {_pct(overall)}**\n\n"
        f"Steam load utilization is **{_pct(load_utilization)}** ({_kg(available_steam_kg)} / {_kg(rated_steam_kg)}), "
        "tracked separately so low process demand does not look like poor boiler performance."
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
        self.oee_efficiency_weighted_sum = 0.0
        self.oee_efficiency_seconds = 0.0
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
                if eff is not None:
                    self.oee_efficiency_weighted_sum += _as_float(eff, OEE_RATED_EFFICIENCY_PCT) * dt
                    self.oee_efficiency_seconds += dt
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
            avg_efficiency = (
                self.oee_efficiency_weighted_sum / self.oee_efficiency_seconds
                if self.oee_efficiency_seconds > 0 else 0.0
            )
            performance = avg_efficiency / OEE_RATED_EFFICIENCY_PCT if OEE_RATED_EFFICIENCY_PCT > 0 else 0.0
            quality = self.oee_good_steam_kg / self.oee_available_steam_kg if self.oee_available_steam_kg > 0 else 0.0
            load_utilization = self.oee_available_steam_kg / self.oee_rated_steam_kg if self.oee_rated_steam_kg > 0 else 0.0
            availability = _clamp(availability)
            performance = _clamp(performance)
            quality = _clamp(quality)
            load_utilization = _clamp(load_utilization, 0.0, 1.5)
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
                    "avg_efficiency_pct": round(avg_efficiency, 2),
                    "rated_efficiency_pct": OEE_RATED_EFFICIENCY_PCT,
                    "load_utilization": round(load_utilization, 4),
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


def call_groq_router(messages, max_tokens=64, json_mode=False):
    """
    Use Groq only for fast routing/classification. This function is intentionally
    narrow: no final operator explanations, no plant diagnosis narrative.
    """
    if not GROQ_API_KEY:
        return None

    headers = {
        "Authorization": f"Bearer {GROQ_API_KEY}",
        "Content-Type": "application/json",
    }
    body = {
        "model": GROQ_ROUTER_MODEL,
        "messages": messages,
        "temperature": 0.0,
        "max_tokens": max_tokens,
    }
    if json_mode:
        body["response_format"] = {"type": "json_object"}

    try:
        resp = requests.post(GROQ_CHAT_URL, headers=headers, json=body, timeout=8)
        if resp.status_code == 200:
            return _strip_think(resp.json()["choices"][0]["message"]["content"])
        print(f"[AI Analyst] Groq router error {resp.status_code}: {resp.text[:160]}")
    except Exception as e:
        print(f"[AI Analyst] Groq router unavailable ({e})")
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
    efficiency_weighted_sum = 0.0
    efficiency_seconds = 0.0
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
            if tags.get("efficiency") is not None:
                efficiency_weighted_sum += _as_float(tags.get("efficiency"), OEE_RATED_EFFICIENCY_PCT) * dt
                efficiency_seconds += dt
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
    avg_efficiency = efficiency_weighted_sum / efficiency_seconds if efficiency_seconds > 0 else 0.0
    performance = avg_efficiency / OEE_RATED_EFFICIENCY_PCT if OEE_RATED_EFFICIENCY_PCT > 0 else 0.0
    quality = good_kg / avail_kg if avail_kg > 0 else 0.0
    load_utilization = avail_kg / rated_kg if rated_kg > 0 else 0.0
    availability = _clamp(availability)
    performance = _clamp(performance)
    quality = _clamp(quality)
    load_utilization = _clamp(load_utilization, 0.0, 1.5)
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
            "avg_efficiency_pct": round(avg_efficiency, 2),
            "rated_efficiency_pct": OEE_RATED_EFFICIENCY_PCT,
            "load_utilization": round(load_utilization, 4),
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


def build_shift_facts(stats):
    """
    Canonical fact contract for shift reports.

    Everything here is measured or deterministically computed. The LLM may
    phrase these facts, but it must not recalculate or reinterpret them.
    """
    alerts = stats.get("alerts", {}) or {}
    by_severity = {
        "CRITICAL": int(_as_float(alerts.get("CRITICAL"), 0)),
        "HIGH": int(_as_float(alerts.get("HIGH"), 0)),
        "WARNING": int(_as_float(alerts.get("WARNING"), 0)),
        "LOW": int(_as_float(alerts.get("LOW"), 0)),
    }
    total_alerts = sum(by_severity.values())
    severe_alerts = by_severity["CRITICAL"] + by_severity["HIGH"] + by_severity["WARNING"]

    eff = stats.get("efficiency", {}) or {}
    eff_start = eff.get("start")
    eff_end = eff.get("end")
    eff_delta = None
    if isinstance(eff_start, (int, float)) and isinstance(eff_end, (int, float)):
        eff_delta = round(eff_end - eff_start, 2)

    oee = stats.get("oee", {}) or {}
    availability_pct = round(_as_float(oee.get("availability"), 0.0) * 100.0, 2)
    performance_pct = round(_as_float(oee.get("performance"), 0.0) * 100.0, 2)
    quality_pct = round(_as_float(oee.get("quality"), 0.0) * 100.0, 2)
    oee_pct = round(_as_float(oee.get("oee"), 0.0) * 100.0, 2)

    return {
        "window": {
            "label": stats.get("shift_label"),
            "duration": stats.get("shift_duration"),
            "start": stats.get("shift_start"),
            "end": stats.get("shift_end"),
            "source": stats.get("data_source"),
        },
        "uptime_pct": _as_float(stats.get("uptime_pct"), 0.0),
        "anomaly_events": int(_as_float(stats.get("anomaly_events"), 0)),
        "alerts": {
            "total": total_alerts,
            "severe_total": severe_alerts,
            "by_severity": by_severity,
            "by_tag": stats.get("alert_breakdown", {}) or stats.get("alerts_by_tag", {}) or {},
        },
        "efficiency": {
            "start_pct": eff_start,
            "end_pct": eff_end,
            "delta_points": eff_delta,
            "min_pct": eff.get("min"),
            "max_pct": eff.get("max"),
        },
        "oee": {
            "availability_pct": availability_pct,
            "performance_pct": performance_pct,
            "quality_pct": quality_pct,
            "oee_pct": oee_pct,
            "planned_seconds": oee.get("planned_seconds"),
            "available_seconds": oee.get("available_seconds"),
            "avg_efficiency_pct": oee.get("avg_efficiency_pct"),
            "rated_efficiency_pct": oee.get("rated_efficiency_pct", OEE_RATED_EFFICIENCY_PCT),
            "load_utilization_pct": round(_as_float(oee.get("load_utilization"), 0.0) * 100.0, 2),
        },
        "steam": {
            "actual_steam_kg": oee.get("actual_steam_kg"),
            "available_steam_kg": oee.get("available_steam_kg"),
            "good_steam_kg": oee.get("good_steam_kg"),
            "rated_steam_basis_kg": oee.get("rated_steam_kg"),
            "rated_steam_flow_kg_hr": oee.get("rated_steam_flow_kg_hr"),
            "good_steam_limits": oee.get("good_steam_limits", {}),
        },
        "modes_seen": stats.get("modes_seen", []) or [],
    }


def build_shift_interpretations(facts):
    """Deterministic domain interpretation for shift reports."""
    alerts = facts["alerts"]["by_severity"]
    critical = alerts["CRITICAL"]
    high = alerts["HIGH"]
    warning = alerts["WARNING"]
    severe_alerts = facts["alerts"]["severe_total"]
    uptime = facts["uptime_pct"]
    availability = facts["oee"]["availability_pct"]
    performance = facts["oee"]["performance_pct"]
    quality = facts["oee"]["quality_pct"]
    eff_delta = facts["efficiency"]["delta_points"]

    if critical > 0 or availability < 50.0 or performance < 85.0 or quality < 80.0:
        status = "poor"
    elif high > 0 or warning > 0 or uptime < 99.0 or performance < 95.0 or (eff_delta is not None and eff_delta < -1.0):
        status = "fair"
    else:
        status = "good"

    interpretations = []
    if severe_alerts:
        parts = []
        if critical: parts.append(f"{critical} CRITICAL")
        if high: parts.append(f"{high} HIGH")
        if warning: parts.append(f"{warning} WARNING")
        interpretations.append(
            f"Alert severity is material: {', '.join(parts)} alert(s) were logged and require investigation."
        )
    else:
        interpretations.append("No CRITICAL, HIGH, or WARNING alerts were logged.")

    if uptime >= 99.0 and availability < 50.0:
        interpretations.append(
            f"Flame uptime ({uptime:.1f}%) and OEE availability ({availability:.2f}%) are different metrics; "
            "do not describe the day as operationally perfect when OEE availability is low."
        )
    if quality < 80.0:
        interpretations.append(
            f"OEE quality was low at {quality:.2f}%, meaning only part of available steam counted as good steam."
        )
    if facts["oee"]["performance_pct"] < 95.0:
        interpretations.append(
            f"OEE performance was {facts['oee']['performance_pct']:.2f}%, based on average thermal efficiency "
            f"against the {facts['oee']['rated_efficiency_pct']:.1f}% rated efficiency basis."
        )
    if eff_delta is not None and abs(eff_delta) < 0.1:
        interpretations.append("Thermal efficiency was stable; keep it separate from OEE availability and quality.")

    return {
        "overall_status": status,
        "interpretations": interpretations,
        "forbidden_claims": [
            "Do not call CRITICAL/HIGH/WARNING alerts benign, harmless, background noise, or system notifications unless a fact explicitly classifies them that way.",
            "Do not compare total steam mass in kg directly against rated flow in kg/hr.",
            "Do not say alerts failed to escalate to HIGH or WARNING; severities are categories, not an escalation ladder.",
            "Do not use 'perfect operation' when severe alerts or poor OEE metrics are present.",
            "Do not imply boiler thermal efficiency and OEE quality/availability are the same metric.",
        ],
    }


def render_shift_report_from_facts(facts, interpretations):
    """Deterministic fallback renderer from certified facts and interpretations."""
    window = facts["window"]
    label = window.get("label") or "Shift"
    duration = window.get("duration") or "the window"
    uptime = facts["uptime_pct"]
    anomalies = facts["anomaly_events"]
    alerts = facts["alerts"]["by_severity"]
    total_alerts = facts["alerts"]["total"]
    status = interpretations["overall_status"]
    eff = facts["efficiency"]
    oee = facts["oee"]
    steam = facts["steam"]

    severity_parts = []
    if alerts["CRITICAL"]: severity_parts.append(f"{alerts['CRITICAL']} critical")
    if alerts["HIGH"]: severity_parts.append(f"{alerts['HIGH']} high")
    if alerts["WARNING"]: severity_parts.append(f"{alerts['WARNING']} warning")
    if alerts["LOW"]: severity_parts.append(f"{alerts['LOW']} low")
    alert_text = f"{total_alerts} alert{'s' if total_alerts != 1 else ''}"
    if severity_parts:
        alert_text += f" ({', '.join(severity_parts)})"

    eff_clause = ""
    if isinstance(eff.get("end_pct"), (int, float)):
        if isinstance(eff.get("delta_points"), (int, float)):
            eff_clause = f" Efficiency ended at {eff['end_pct']:.1f}% ({eff['delta_points']:+.1f} pts vs start)."
        else:
            eff_clause = f" Efficiency ended at {eff['end_pct']:.1f}%."

    summary = (
        f"{label} - {duration} elapsed. BOILER-01 recorded {uptime:.1f}% flame uptime, "
        f"{anomalies} anomaly event{'s' if anomalies != 1 else ''}, and {alert_text}."
        f"{eff_clause} Overall shift status is {status.upper()}."
    )

    highlights = []
    if severity_parts:
        highlights.append(f"Alerts: {', '.join(severity_parts)}.")
    else:
        highlights.append("No alerts fired this shift.")
    highlights.append(
        f"OEE {oee['oee_pct']:.2f}% "
        f"(availability {oee['availability_pct']:.2f}%, thermal performance {oee['performance_pct']:.2f}%, "
        f"quality {oee['quality_pct']:.2f}%)."
    )
    if isinstance(oee.get("avg_efficiency_pct"), (int, float)):
        highlights.append(
            f"Average thermal efficiency basis: {oee['avg_efficiency_pct']:.2f}% "
            f"vs rated {oee['rated_efficiency_pct']:.1f}%."
        )
    if steam.get("actual_steam_kg") is not None and steam.get("good_steam_kg") is not None:
        highlights.append(
            f"Steam mass: {steam['actual_steam_kg']:.2f} kg total, "
            f"{steam['good_steam_kg']:.2f} kg counted as good steam; "
            f"load utilization {oee.get('load_utilization_pct', 0.0):.2f}%."
        )
    if isinstance(eff.get("min_pct"), (int, float)) and isinstance(eff.get("max_pct"), (int, float)):
        highlights.append(f"Efficiency range was {eff['min_pct']:.2f}% to {eff['max_pct']:.2f}%.")
    if facts["modes_seen"]:
        highlights.append(f"Operating modes seen: {', '.join(str(m) for m in facts['modes_seen'])}.")

    follow_ups = []
    if alerts["CRITICAL"]:
        follow_ups.append("Review the CRITICAL alert sequence and affected tags before the next start-up.")
    elif alerts["HIGH"] or alerts["WARNING"]:
        follow_ups.append("Review repeated HIGH/WARNING alerts for developing operating issues.")
    if oee["availability_pct"] < 50.0:
        follow_ups.append("Reconcile low OEE availability against planned operating time and maintenance logs.")
    if oee["quality_pct"] < 80.0:
        follow_ups.append("Check pressure, steam temperature, and drum level against the good-steam limits.")
    if not follow_ups:
        follow_ups.append("No corrective action required; continue routine monitoring.")
        follow_ups.append("Verify feedwater and combustion setpoints at next shift handover.")

    return {
        "summary": summary,
        "overall_status": status,
        "highlights": highlights[:5],
        "follow_ups": follow_ups[:4],
    }


def validate_shift_report(narrative, facts, interpretations):
    """
    Validate generated prose against the fact contract.

    Returns (cleaned_narrative, issues). Any issue means the caller should use
    the deterministic fallback for the user-facing report.
    """
    fallback = render_shift_report_from_facts(facts, interpretations)

    def as_text_list(value):
        if not isinstance(value, list):
            return []
        return [str(item).strip() for item in value if str(item).strip()]

    cleaned = {
        "summary": str(narrative.get("summary") or "").strip(),
        "overall_status": str(narrative.get("overall_status") or "").strip().lower(),
        "highlights": as_text_list(narrative.get("highlights")),
        "follow_ups": as_text_list(narrative.get("follow_ups")),
    }
    if not cleaned["summary"] or cleaned["overall_status"] not in ("good", "fair", "poor"):
        return fallback, ["missing_or_invalid_required_fields"]

    text = " ".join([cleaned["summary"], *cleaned["highlights"], *cleaned["follow_ups"]]).lower()
    issues = []
    alerts = facts["alerts"]["by_severity"]
    severe_alerts = facts["alerts"]["severe_total"]

    bad_alert_phrases = (
        "non-operational",
        "system notification",
        "system notifications",
        "background noise",
        "benign",
        "harmless",
        "alert noise",
    )
    if severe_alerts and any(phrase in text for phrase in bad_alert_phrases):
        issues.append("severe_alerts_softened")
    if alerts["CRITICAL"] and f"{alerts['CRITICAL']} critical" not in text:
        issues.append("critical_count_missing")
    if severe_alerts and cleaned["overall_status"] != interpretations["overall_status"]:
        issues.append("status_conflicts_with_facts")
    if "escalat" in text and severe_alerts:
        issues.append("severity_ladder_claim")
    if "kg/hr" in text and ("kg against" in text or "against a rated flow" in text or "against rated flow" in text):
        issues.append("mass_flow_unit_mix")
    if ("perfect operation" in text or "perfect operational" in text) and (
        severe_alerts
        or facts["oee"]["availability_pct"] < 99.0
        or facts["oee"]["performance_pct"] < 99.0
        or facts["oee"]["quality_pct"] < 99.0
    ):
        issues.append("perfect_operation_conflicts_with_facts")

    if issues:
        return fallback, issues
    return cleaned, []


def build_shift_narrative(stats):
    """Reason an end-of-shift narrative directly from the computed stats dict."""
    facts = build_shift_facts(stats)
    interpretations = build_shift_interpretations(facts)
    return render_shift_report_from_facts(facts, interpretations)


def enforce_shift_report_facts(stats, narrative):
    """
    Compatibility wrapper for the report validator.

    Existing callers pass raw stats plus generated narrative. Internally we now
    validate against the canonical fact contract and fall back deterministically
    if the narrative drifts.
    """
    facts = build_shift_facts(stats)
    interpretations = build_shift_interpretations(facts)
    cleaned, _issues = validate_shift_report(narrative, facts, interpretations)
    return cleaned


# ============================================================
# SHIFT REPORT REQUEST ROUTING (chat -> historical shift report)
# ============================================================
# The end-of-shift report card can be produced for any past shift/day, not just
# the current live shift. A typed question like "what was the shift report for
# 4th july" or "night shift summary yesterday" is resolved to a concrete window
# and rendered with the SAME shift-report template (compute_shift_stats_from_rows
# + build_shift_narrative) over historian data for that window.

# Shift-name -> that shift's start hour (matches the default 6/14/22 schedule).
_SHIFT_NAME_HOURS = {
    "day": 6, "morning": 6, "first": 6,
    "swing": 14, "afternoon": 14, "evening": 14, "second": 14, "middle": 14,
    "night": 22, "graveyard": 22, "overnight": 22, "third": 22,
}

_REPORT_WORDS = ("report", "summary", "recap", "rundown", "handover", "overview", "debrief")


def _is_shift_report_request(question):
    """
    True when the operator is asking for a shift/end-of-shift report in prose
    (not the button, which carries a type marker). Requires both a report word
    and the word 'shift' so ordinary questions that merely mention a shift
    ('is this a good shift') are not hijacked.
    """
    q = (question or "").lower()
    if "shift report" in q or "shift summary" in q or "shift handover" in q:
        return True
    return "shift" in q and any(w in q for w in _REPORT_WORDS)


def parse_shift_report_target(question, now_dt):
    """
    Resolve the window a shift-report request refers to.

    Returns (start, end, label) as tz-aware local datetimes, or None to mean
    "the current live shift" (no past date/shift named — caller falls back to the
    default current-shift path).

    Handled forms:
      - explicit date, no shift  -> that whole calendar day
      - named shift (+ date)     -> that fixed 8h shift on the date (today if none)
      - 'yesterday'              -> the whole previous calendar day
      - 'last'/'previous shift'  -> the shift immediately before the current one
    """
    q = (question or "").lower()

    # Named shift ("night shift", "day shift") -> its start hour.
    named_hour = None
    for name, hour in _SHIFT_NAME_HOURS.items():
        if re.search(r"(?<![a-z])" + name + r"(?![a-z])", q):
            named_hour = hour
            break

    # Calendar-date anchor: explicit date, or yesterday.
    anchor_date = None
    if historian_parse_explicit_date is not None:
        explicit = historian_parse_explicit_date(q, now_dt)
        if explicit:
            anchor_date = explicit[0]
    if anchor_date is None and "day before yesterday" in q:
        anchor_date = (now_dt - timedelta(days=2)).date()
    elif anchor_date is None and "yesterday" in q:
        anchor_date = (now_dt - timedelta(days=1)).date()

    tz = now_dt.tzinfo

    # "last shift" / "previous shift" — the shift before the one now falls in.
    if anchor_date is None and named_hour is None:
        if any(t in q for t in ("last shift", "previous shift", "prior shift", "shift before")):
            cur_start, _, _ = current_shift_window(now_dt)
            prev_target = cur_start - timedelta(minutes=30)  # sits inside the previous shift
            s, e, base = current_shift_window(prev_target)
            return s, e, f"{base} - {s:%a %d %b}"
        # No date/shift named -> current shift (handled by the default path).
        return None

    # A named shift, optionally on a given date.
    if named_hour is not None:
        d = anchor_date or now_dt.date()
        # Aim one hour into the shift so we land squarely inside it.
        target = datetime(d.year, d.month, d.day, named_hour, 0, tzinfo=tz) + timedelta(hours=1)
        if anchor_date is None and target > now_dt:
            target -= timedelta(days=1)  # that shift is still in the future today
        s, e, base = current_shift_window(target)
        return s, e, f"{base} - {s:%a %d %b}"

    # A bare date with no shift named -> the whole calendar day.
    start = datetime(anchor_date.year, anchor_date.month, anchor_date.day, tzinfo=tz)
    end = min(start + timedelta(days=1), now_dt)
    if end <= start:
        return None
    day_label = start.strftime("%b %d").replace(" 0", " ")
    return start, end, f"{day_label} (full day)"


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
        self.last_oee_publish = 0

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
            client.subscribe(TOPIC_OEE_REQUEST)
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
                self.publish_current_oee()

            elif topic == TOPIC_ANOMALY:
                self.handle_anomaly(payload)

            elif topic == TOPIC_ALERTS:
                self.handle_alert(payload)

            elif topic == TOPIC_CHAT_IN:
                self.handle_chat(payload)

            elif topic == TOPIC_OEE_REQUEST:
                self.handle_oee_history_request(payload)

        except Exception as e:
            print(f"[AI Analyst] Message error: {e}")

    def _oee_snapshot_payload(self, stats, shift_start, shift_end, shift_label, data_source, payload_type="oee_update"):
        """Build the OEE payload shared by live updates and historical responses."""
        return {
            "type": payload_type,
            "timestamp": time.time(),
            "shift_label": shift_label,
            "shift_start": shift_start.isoformat(),
            "shift_end": shift_end.isoformat(),
            "shift_duration": stats.get("shift_duration"),
            "data_source": data_source,
            "uptime_pct": stats.get("uptime_pct"),
            "anomaly_events": stats.get("anomaly_events", 0),
            "alerts": stats.get("alerts", {}),
            "efficiency": stats.get("efficiency", {}),
            "oee": stats.get("oee", {}),
            "modes_seen": stats.get("modes_seen", []),
        }

    def publish_current_oee(self):
        """Publish current-shift OEE periodically for dashboard pages."""
        now = time.time()
        if now - self.last_oee_publish < 3.0:
            return
        self.last_oee_publish = now
        shift_start, shift_end, shift_label = current_shift_window(datetime.now().astimezone())
        stats = self.stats.snapshot()
        payload = self._oee_snapshot_payload(
            stats, shift_start, shift_end, shift_label, "in_memory", payload_type="oee_update"
        )
        self.mqtt_client.publish(TOPIC_OEE, json.dumps(payload), qos=1)

    @staticmethod
    def _timeline_from_rows(rows):
        """Compress historian samples into simple operating-state timeline segments."""
        if not rows:
            return []

        def state_for(row):
            tags = row.get("tags", {})
            mode = row.get("mode") or "NORMAL"
            if mode == "FAULT" or not bool(tags.get("flame_status", 1)):
                return "downtime"
            if mode == "CRITICAL" or bool(tags.get("safety_valve", 0)):
                return "critical"
            if mode == "DEGRADING" or _as_float(tags.get("efficiency"), OEE_RATED_EFFICIENCY_PCT) < 82.0:
                return "slow"
            return "production"

        segments = []
        current = None
        start_ts = None
        last_ts = None
        for row in rows:
            ts = row["ts_epoch"]
            state = state_for(row)
            if current is None:
                current = state
                start_ts = ts
            elif state != current:
                segments.append({"state": current, "start": start_ts, "end": last_ts or ts})
                current = state
                start_ts = ts
            last_ts = ts
        if current is not None:
            segments.append({"state": current, "start": start_ts, "end": last_ts or start_ts})
        return segments[:240]

    def handle_oee_history_request(self, payload):
        """Return OEE snapshots for recent fixed shifts over MQTT."""
        limit = int(_as_float((payload or {}).get("limit"), 7))
        limit = max(1, min(limit, 14))
        now_local_dt = datetime.now().astimezone()
        current_start, current_end, current_label = current_shift_window(now_local_dt)
        shifts = []

        # Current shift first.
        current_stats, live_start, live_end, live_label, data_source = self._resolve_shift_stats()
        shifts.append(self._oee_snapshot_payload(
            current_stats, live_start, live_end, live_label, data_source, payload_type="oee_shift"
        ))

        cursor = current_start - timedelta(minutes=1)
        for _ in range(limit - 1):
            start, end, label = current_shift_window(cursor)
            cursor = start - timedelta(minutes=1)
            if fetch_telemetry_window is None or count_events_window is None:
                break
            try:
                rows = fetch_telemetry_window(start, end)
                if not rows:
                    shifts.append({
                        "type": "oee_shift",
                        "timestamp": time.time(),
                        "shift_label": label,
                        "shift_start": start.isoformat(),
                        "shift_end": end.isoformat(),
                        "data_source": "historian",
                        "empty": True,
                    })
                    continue
                events = count_events_window(start, end)
                stats = compute_shift_stats_from_rows(
                    rows, (end - start).total_seconds(), events["alerts"], events["anomaly_episodes"]
                )
                item = self._oee_snapshot_payload(
                    stats, start, end, label, "historian", payload_type="oee_shift"
                )
                item["status_timeline"] = self._timeline_from_rows(rows)
                shifts.append(item)
            except Exception as e:
                print(f"[AI Analyst] OEE history window failed ({e})")

        response = {
            "type": "oee_history",
            "timestamp": time.time(),
            "current_shift_label": current_label,
            "shifts": shifts,
        }
        self.mqtt_client.publish(TOPIC_OEE_HISTORY, json.dumps(response), qos=1)

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
    # When the operator names a sensor, decide what they actually want. The PATH
    # decision is made by the Groq reasoning model (qwen/qwen3.6-27b) so it can
    # actually reason about intent — e.g. "is the O2 control loop stable?" or
    # "is the pressure controller hunting?" resolve to REASON, not a canned value
    # read-out. Only the routing runs on Groq; the final operator answer is still
    # generated by the local Ollama model. Falls back to the local model, then to
    # the keyword heuristic, if Groq is unreachable.
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

        The path is decided by the Groq reasoning model first; if Groq is
        unreachable we retry on the local Ollama model, and only then give up so
        the caller uses the keyword heuristic.
        """
        messages = [
            {"role": "system", "content": self._INTENT_ROUTER_PROMPT},
            {"role": "user", "content": question},
        ]
        try:
            # Primary: Groq reasoning model (qwen/qwen3.6-27b) reasons the path.
            # It emits a <think> trace before the label, so give it enough budget
            # to finish reasoning (a smaller budget truncates before the answer);
            # call_groq_router strips the <think> block and we read the label.
            result = call_groq_router(messages, max_tokens=512)
            if not result:
                # Groq down/unconfigured -> local Ollama, tiny fast budget.
                result = call_llm(messages, json_mode=False, max_tokens=8, think=False)
            if not result:
                return None
            # Take the LAST label in the reply so a reasoning trace that mentions
            # other options does not override the model's final decision.
            words = result.strip().upper().replace("\n", " ").split()
            for word in reversed(words):
                if word in ("HISTORY", "REASON", "VALUE"):
                    print(f"[AI Analyst] Intent route: {word} <- {question[:60]}")
                    return word
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

        # Historical / explicit shift-report requests typed in chat, e.g.
        # "what was the shift report for 4th july", "night shift summary yesterday".
        # These reuse the SAME shift-report card template as the toolbar button,
        # but computed over the requested past window. Resolved before intent
        # routing so a report request is never mistaken for a sensor/OEE query.
        if _is_shift_report_request(question):
            window = parse_shift_report_target(question, datetime.now().astimezone())
            target_label = "the current shift" if window is None else window[2]
            print(f"[AI Analyst] Shift report request via chat -> {target_label}: {question[:70]}")
            self.chat_history.append({"role": "user", "content": question})
            self.chat_history.append({
                "role": "assistant",
                "content": f"[Generated the end-of-shift report for {target_label}.]",
            })
            self.handle_shift_report(window=window)
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

        # Deterministic historical answers (e.g. "efficiency for 4th july",
        # "average O2 yesterday 11am-5pm") run BEFORE the domain guardrail: they
        # only fire when an explicit sensor tag is named, so they are already
        # on-domain, and this keeps a flaky classifier from blocking a valid
        # date/time query. Same pattern as the current-value and OEE answers above.
        if answer_historical_metric_question is not None:
            historical_answer = answer_historical_metric_question(question)
            if historical_answer:
                print(f"[AI Analyst] Historical metric answer: {question[:70]}")
                self.chat_history.append({"role": "user", "content": question})
                self.chat_history.append({"role": "assistant", "content": historical_answer})
                self.mqtt_client.publish(TOPIC_CHAT_OUT, json.dumps({
                    "answer": historical_answer,
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

        # (Historical metric answers are served earlier, before the guardrail.)

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

    def _resolve_shift_stats_for_window(self, start, end):
        """
        Historian-backed shift snapshot for an explicit PAST window (used by
        report requests that name a date/shift). Mirrors _resolve_shift_stats but
        has no in-memory fallback — the live accumulators only describe the
        current shift, so a window with no stored telemetry returns (None, ...).
        Returns (stats, data_source).
        """
        planned_seconds = (end - start).total_seconds()
        if fetch_telemetry_window is None or count_events_window is None:
            print("[AI Analyst] Historian unavailable — cannot build historical shift report")
            return None, "unavailable"
        try:
            rows = fetch_telemetry_window(start, end)
            if not rows:
                return None, "historian"
            events = count_events_window(start, end)
            stats = compute_shift_stats_from_rows(
                rows, planned_seconds, events["alerts"], events["anomaly_episodes"]
            )
            print(f"[AI Analyst] Historical shift stats: {len(rows)} samples "
                  f"over {start.isoformat()} - {end.isoformat()}")
            return stats, "historian"
        except Exception as e:
            print(f"[AI Analyst] Historical shift query failed ({e})")
            return None, "historian"

    def _publish_empty_shift_report(self, shift_start, shift_end, shift_label):
        """Send a shift-report card explaining that no telemetry exists for the window."""
        report = {
            "type": "shift_report",
            "timestamp": time.time(),
            "shift_label": shift_label,
            "shift_start": shift_start.isoformat(),
            "shift_end": shift_end.isoformat(),
            "data_source": "historian",
            "summary": (
                f"No telemetry is stored for {shift_label}, so a shift report cannot be "
                f"generated for that window. The historian only holds data from periods the "
                f"plant was being monitored."
            ),
            "overall_status": "unknown",
            "highlights": [f"No historian samples found for {shift_label}."],
            "follow_ups": [
                "Choose a shift or date the historian has data for.",
                "Or ask for the current shift report.",
            ],
        }
        self.mqtt_client.publish(TOPIC_CHAT_OUT, json.dumps(report), qos=1)
        self.mqtt_client.publish(TOPIC_AI_STATUS, json.dumps({"status": "online"}), qos=1)
        print(f"[AI Analyst] Empty shift report published for {shift_label}")

    def handle_shift_report(self, window=None):
        """
        Generate an end-of-shift summary report.

        window=None  -> the current fixed 8h shift (toolbar button / default).
        window=(start, end, label) -> a specific past shift/day requested in chat,
        rendered with the identical report template over historian data.
        """
        print("[AI Analyst] Shift report requested. Generating...")
        self.mqtt_client.publish(TOPIC_AI_STATUS, json.dumps({"status": "analyzing"}), qos=1)

        if window is None:
            stats, shift_start, shift_end, shift_label, data_source = self._resolve_shift_stats()
        else:
            shift_start, shift_end, shift_label = window
            stats, data_source = self._resolve_shift_stats_for_window(shift_start, shift_end)
            if stats is None:
                self._publish_empty_shift_report(shift_start, shift_end, shift_label)
                return
        stats["shift_label"] = shift_label
        stats["shift_start"] = shift_start.isoformat()
        stats["shift_end"] = shift_end.isoformat()
        stats["data_source"] = data_source
        facts = build_shift_facts(stats)
        interpretations = build_shift_interpretations(facts)

        # Live readings only make sense for the CURRENT shift. For a historical
        # window they would misleadingly describe "now", not the past shift, so
        # we drop them and let the model reason purely from the stored stats.
        is_historical = window is not None

        system_content = (
            "You are a boiler operations supervisor AI for NEXUS OS writing an end-of-shift report for BOILER-01. "
            "The report covers the operating window named by shift_label in the facts "
            "(a fixed 8-hour shift, or a full day when the label says so). "
            "You are given SHIFT FACTS computed locally and APPROVED INTERPRETATIONS from deterministic rules. "
            "Treat those as ground truth. Do not calculate new metrics, infer new causes, or reinterpret severity. "
            "Reference the window by its label. Return strict JSON with these fields: "
            "\"summary\" (string, 1-2 sentence narrative of the window), "
            "\"overall_status\" (string: good/fair/poor), "
            "\"highlights\" (array of 3-5 short strings: notable events, trends, or confirmations of stability), "
            "\"follow_ups\" (array of 2-4 short strings: specific recommended actions for the next shift). "
            "Cite specific values from SHIFT FACTS where relevant. Do not invent events not supported by the facts. "
            "Obey every forbidden claim exactly."
        )
        if is_historical:
            system_content += (
                " This is a HISTORICAL report reconstructed from the historian for a PAST window. "
                "Write it in the past tense and use only the statistics provided — do not reference the current live state."
            )

        user_content = (
            f"WINDOW: {shift_label} (source: {data_source})\n\n"
            f"SHIFT FACTS:\n{json.dumps(facts, indent=2)}\n\n"
            f"APPROVED INTERPRETATIONS:\n{json.dumps(interpretations, indent=2)}\n\n"
        )
        if not is_historical:
            latest = self.telemetry.get_latest_summary()
            trend = self.telemetry.get_context(last_n=60)
            user_content += (
                f"CURRENT READINGS:\n{latest}\n\n"
                f"RECENT TREND (last 60 seconds):\n{trend}\n\n"
            )
        user_content += "Write the end-of-shift report as JSON."

        messages = [
            {"role": "system", "content": system_content},
            {"role": "user", "content": user_content},
        ]

        # Reasoning models (qwen3.5 is the current default) are verbose, so give
        # the JSON enough room to finish — a 600-token cap truncated it mid-object
        # and the narrative failed to parse. think=False keeps reasoning out of the
        # token budget so the whole allowance goes to the JSON answer.
        response = call_llm(messages, json_mode=True, max_tokens=1200, think=False)
        report = dict(stats)
        report["type"] = "shift_report"
        report["timestamp"] = time.time()
        report["fact_contract"] = facts
        report["interpretation_contract"] = interpretations

        # Deterministic narrative reasoned straight from the stats — always valid.
        # The LLM narrative layers on top of it when (and only when) it parses.
        narrative = render_shift_report_from_facts(facts, interpretations)

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

        narrative, validation_issues = validate_shift_report(narrative, facts, interpretations)
        report["validation_issues"] = validation_issues
        if validation_issues:
            print(f"[AI Analyst] Shift report validation fallback: {', '.join(validation_issues)}")

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
