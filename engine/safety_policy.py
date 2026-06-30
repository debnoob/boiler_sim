"""
NEXUS OS safety policy layer.

This module is deliberately deterministic. It does not detect anomalies; it
classifies the current plant state, identifies contradictory evidence, and
blocks unsafe or unsupported LLM recommendations before they reach the UI.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any


BASELINES = {
    "steam_pressure": 10.0,
    "steam_temperature": 180.0,
    "steam_flow": 2300.0,
    "drum_level": 400.0,
    "feedwater_flow": 2300.0,
    "fuel_flow": 138.0,
    "air_flow": 1518.0,
    "o2_percent": 3.2,
    "flue_gas_temp": 198.0,
    "tube_health": 97.0,
    "efficiency": 87.0,
}


@dataclass
class SafetyContext:
    intent: str
    states: dict[str, str]
    latest: dict[str, Any]
    trends: dict[str, str] = field(default_factory=dict)
    contradictions: list[str] = field(default_factory=list)
    blocked_actions: dict[str, str] = field(default_factory=dict)
    required_guidance: list[str] = field(default_factory=list)
    safe_actions: list[str] = field(default_factory=list)


def classify_intent(question: str) -> str:
    q = question.lower()
    if "what if" in q[:60]:
        return "what_if"
    if any(k in q for k in ("pid", "kp", "ki", "kd", "tuning", "control loop", "controller gain")):
        return "pid_tuning"
    if any(k in q for k in ("what should", "recommend", "action", "fix", "next step", "what do i do")):
        return "recommend_action"
    if any(k in q for k in ("why", "cause", "explain", "reason")):
        return "why_explain"
    if any(k in q for k in ("manual", "procedure", "section", "oem", "datasheet")):
        return "manual_question"
    return "chat"


def _num(tags: dict[str, Any], key: str, default: float = 0.0) -> float:
    try:
        return float(tags.get(key, default))
    except (TypeError, ValueError):
        return default


def _flow_state(value: float, baseline: float) -> str:
    if value <= max(1.0, baseline * 0.02):
        return "ZERO"
    if value < baseline * 0.50:
        return "LOW"
    if value > baseline * 1.25:
        return "HIGH"
    return "NORMAL"


def _trend(samples: list[dict[str, Any]], tag: str, deadband: float) -> str:
    values = []
    for sample in samples[-12:]:
        tags = sample.get("tags", {})
        if tag in tags:
            values.append(_num(tags, tag))
    if len(values) < 4:
        return "UNKNOWN"
    slope = (values[-1] - values[0]) / max(len(values) - 1, 1)
    if slope > deadband:
        return "RISING"
    if slope < -deadband:
        return "FALLING"
    return "STABLE"


def classify_plant_state(samples: list[dict[str, Any]]) -> tuple[dict[str, str], dict[str, str], dict[str, Any]]:
    latest = samples[-1].get("tags", {}) if samples else {}

    drum = _num(latest, "drum_level", BASELINES["drum_level"])
    pressure = _num(latest, "steam_pressure", BASELINES["steam_pressure"])
    o2 = _num(latest, "o2_percent", BASELINES["o2_percent"])
    fgt = _num(latest, "flue_gas_temp", BASELINES["flue_gas_temp"])
    tube = _num(latest, "tube_health", BASELINES["tube_health"])
    eff = _num(latest, "efficiency", BASELINES["efficiency"])
    flame = int(_num(latest, "flame_status", 1))
    safety_valve = int(_num(latest, "safety_valve", 0))

    states = {
        "drum_level": (
            "CRITICAL_HIGH" if drum >= 720 else
            "HIGH" if drum > 600 else
            "CRITICAL_LOW" if drum < 200 else
            "LOW" if drum < 280 else
            "NORMAL"
        ),
        "feedwater_flow": _flow_state(_num(latest, "feedwater_flow"), BASELINES["feedwater_flow"]),
        "steam_flow": _flow_state(_num(latest, "steam_flow"), BASELINES["steam_flow"]),
        "fuel_flow": _flow_state(_num(latest, "fuel_flow"), BASELINES["fuel_flow"]),
        "air_flow": _flow_state(_num(latest, "air_flow"), BASELINES["air_flow"]),
        "steam_pressure": "CRITICAL_HIGH" if pressure >= 13.5 else "HIGH" if pressure > 13.0 else "NORMAL",
        "o2_percent": "LOW" if o2 < 2.0 else "HIGH" if o2 > 4.0 else "OPTIMAL",
        "flue_gas_temp": "CRITICAL_HIGH" if fgt > 240 else "HIGH" if fgt > 220 else "NORMAL",
        "tube_health": "INSPECTION_REQUIRED" if tube < 70 else "DEGRADED" if tube < 80 else "NORMAL",
        "efficiency": "CRITICAL_LOW" if eff < 75 else "LOW" if eff < 82 else "NORMAL",
        "flame_status": "OFF" if flame == 0 else "ON",
        "safety_valve": "OPEN" if safety_valve else "CLOSED",
    }

    trends = {
        "drum_level": _trend(samples, "drum_level", 2.0),
        "steam_pressure": _trend(samples, "steam_pressure", 0.03),
        "feedwater_flow": _trend(samples, "feedwater_flow", 25.0),
        "steam_flow": _trend(samples, "steam_flow", 25.0),
        "flue_gas_temp": _trend(samples, "flue_gas_temp", 0.4),
        "efficiency": _trend(samples, "efficiency", 0.05),
        "tube_health": _trend(samples, "tube_health", 0.03),
    }
    return states, trends, latest


def detect_contradictions(states: dict[str, str], trends: dict[str, str]) -> list[str]:
    c: list[str] = []

    drum_high = states["drum_level"] in ("HIGH", "CRITICAL_HIGH")
    drum_low = states["drum_level"] in ("LOW", "CRITICAL_LOW")
    fw_low = states["feedwater_flow"] in ("ZERO", "LOW")
    fw_high = states["feedwater_flow"] == "HIGH"
    steam_not_low = states["steam_flow"] in ("NORMAL", "HIGH")

    if drum_high and fw_low and steam_not_low:
        c.append(
            "High drum level is not supported by low/zero feedwater with normal steam outflow. "
            "Prefer sensor drift, inconsistent telemetry, unmetered inflow, or level transmitter error over feedwater-bypass diagnosis."
        )
    elif drum_high and fw_high:
        c.append("High drum level with high feedwater flow supports overfeed or feedwater control mismatch.")
    elif drum_low and fw_low:
        c.append("Low drum level with low/zero feedwater supports feedwater starvation or valve/pump restriction.")

    if states["steam_pressure"] in ("HIGH", "CRITICAL_HIGH") and states["fuel_flow"] in ("ZERO", "LOW") and steam_not_low:
        c.append("High steam pressure is weakly supported while fuel is low and steam outflow is normal/high; check pressure sensor or outlet restriction.")

    if states["flame_status"] == "OFF" and states["fuel_flow"] not in ("ZERO", "LOW"):
        c.append("Flame is off while fuel flow is non-zero; treat as unsafe telemetry/control mismatch until verified locally.")

    if states["efficiency"] in ("LOW", "CRITICAL_LOW") and states["flue_gas_temp"] in ("HIGH", "CRITICAL_HIGH"):
        c.append("Low efficiency with high flue-gas temperature supports heat-transfer loss, excess air, or fouling.")

    if trends.get("drum_level") == "RISING" and fw_low and steam_not_low:
        c.append("Drum level trend rising while measured feedwater is low/zero is contradictory; do not force a feedwater valve fault diagnosis.")

    return c


ACTION_PATTERNS = {
    "increase_feedwater": (
        "increase feedwater", "open feedwater", "raise feedwater", "add feedwater",
        "feedwater pump speed", "feedwater valve to maximum"
    ),
    "decrease_feedwater": (
        "reduce feedwater", "stop feedwater", "close feedwater", "lower feedwater"
    ),
    "bypass": (
        "bypass feedwater", "bypass the feedwater", "bypass control valve",
        "manual isolation valve", "manual bypass"
    ),
    "pid_tuning": (
        "increase drum level pid", "reduce drum level pid", "pid kp", "pid ki",
        "pid kd", "increase kp", "reduce kp", "increase ki", "reduce ki",
        "increase kd", "reduce kd", "retune", "tuning"
    ),
    "increase_firing": (
        "increase firing", "raise firing", "increase fuel", "raise fuel flow"
    ),
    "reduce_air": (
        "reduce air", "close air damper", "trim air damper", "lower air flow"
    ),
}


def compute_blocked_actions(intent: str, states: dict[str, str]) -> dict[str, str]:
    blocked: dict[str, str] = {}

    if intent != "pid_tuning":
        blocked["pid_tuning"] = "PID tuning is only allowed when the operator explicitly asks about PID/gains/control-loop tuning."

    blocked["bypass"] = "Bypass/manual override recommendations are blocked unless a verified procedure and safe state are explicitly established."

    if states["drum_level"] in ("HIGH", "CRITICAL_HIGH"):
        blocked["increase_feedwater"] = "Do not recommend increasing feedwater while drum level is high."
        blocked["bypass"] = "Do not recommend feedwater bypass/manual feed while drum level is high."

    if states["drum_level"] in ("LOW", "CRITICAL_LOW"):
        blocked["decrease_feedwater"] = "Do not recommend reducing feedwater while drum level is low."

    if states["steam_pressure"] in ("HIGH", "CRITICAL_HIGH"):
        blocked["increase_firing"] = "Do not recommend increasing firing/fuel while steam pressure is high."

    if states["o2_percent"] == "LOW":
        blocked["reduce_air"] = "Do not recommend reducing air while O2 is low."

    if states["flame_status"] == "OFF":
        blocked["increase_firing"] = "Do not recommend firing/fuel increases while flame is not proven."

    return blocked


def safe_guidance_for_state(states: dict[str, str], contradictions: list[str]) -> list[str]:
    guidance: list[str] = []

    if states["drum_level"] in ("HIGH", "CRITICAL_HIGH"):
        guidance.extend([
            "Verify gauge glass against MQTT drum_level before acting on the transmitter value.",
            "Confirm actual feedwater valve position and whether any unmetered/manual water path is open.",
            "Check steam_flow/load; low steam demand can keep level high.",
            "If high level is locally confirmed, reduce or stop feedwater per site procedure and watch for carryover/wet steam.",
        ])
    elif states["drum_level"] in ("LOW", "CRITICAL_LOW"):
        guidance.extend([
            "Verify gauge glass against MQTT drum_level immediately.",
            "Confirm feedwater pump/valve availability and restore feedwater if level is confirmed low.",
            "Reduce load if level continues falling; follow site trip procedure at critical low level.",
        ])

    if contradictions:
        guidance.append("State that telemetry is contradictory instead of forcing a single root cause.")

    if states["steam_pressure"] in ("HIGH", "CRITICAL_HIGH"):
        guidance.append("Avoid firing increases; verify steam demand/outlet restriction and safety-valve margin.")

    if states["o2_percent"] == "LOW":
        guidance.append("Avoid reducing air; restore O2 to the safe band before increasing load.")

    return guidance[:6]


def build_safety_context(question: str, samples: list[dict[str, Any]]) -> SafetyContext:
    intent = classify_intent(question)
    states, trends, latest = classify_plant_state(samples)
    contradictions = detect_contradictions(states, trends)
    blocked = compute_blocked_actions(intent, states)
    guidance = safe_guidance_for_state(states, contradictions)

    required = [
        "If evidence is contradictory, explicitly say so and avoid forcing a single fault diagnosis.",
        "Do not recommend blocked actions.",
        "Do not provide PID gain changes unless intent is pid_tuning.",
    ]
    if intent not in ("recommend_action", "pid_tuning", "what_if"):
        required.append("For explanation-only questions, keep actions limited to verification/inspection unless the operator asks for next steps.")

    return SafetyContext(
        intent=intent,
        states=states,
        trends=trends,
        latest=latest,
        contradictions=contradictions,
        blocked_actions=blocked,
        required_guidance=required,
        safe_actions=guidance,
    )


def format_safety_context_for_prompt(ctx: SafetyContext) -> str:
    state_bits = ", ".join(f"{k}={v}" for k, v in sorted(ctx.states.items()))
    trend_bits = ", ".join(f"{k}={v}" for k, v in sorted(ctx.trends.items()) if v != "UNKNOWN")
    lines = [
        "SAFETY POLICY LAYER (mandatory):",
        f"- Intent: {ctx.intent}",
        f"- Plant states: {state_bits}",
    ]
    if trend_bits:
        lines.append(f"- Trends: {trend_bits}")
    if ctx.contradictions:
        lines.append("- Contradictory evidence:")
        lines.extend(f"  - {item}" for item in ctx.contradictions)
    if ctx.blocked_actions:
        lines.append("- Blocked action classes:")
        lines.extend(f"  - {name}: {reason}" for name, reason in ctx.blocked_actions.items())
    if ctx.safe_actions:
        lines.append("- Safe guidance to prefer:")
        lines.extend(f"  - {item}" for item in ctx.safe_actions)
    lines.append("- Required behavior:")
    lines.extend(f"  - {item}" for item in ctx.required_guidance)
    return "\n".join(lines)


def _line_has_pattern(line: str, phrases: tuple[str, ...]) -> bool:
    lower = line.lower()
    return any(phrase in lower for phrase in phrases)


def _blocked_classes_in_line(line: str, ctx: SafetyContext) -> list[str]:
    return [
        action
        for action in ctx.blocked_actions
        if _line_has_pattern(line, ACTION_PATTERNS.get(action, ()))
    ]


def _unsupported_claim(line: str, ctx: SafetyContext) -> str | None:
    lower = line.lower()
    drum_contradiction = any("High drum level is not supported" in c for c in ctx.contradictions)
    if drum_contradiction and any(p in lower for p in ("feedwater valve fault", "feedwater bypass", "bypass issue", "valve being in bypass")):
        return "Unsupported feedwater-bypass/root-cause claim under high-level + low-flow contradictory evidence."
    return None


def validate_llm_text(text: str, ctx: SafetyContext) -> tuple[str, list[str]]:
    blocked_notes: list[str] = []
    kept_lines: list[str] = []

    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            kept_lines.append(line)
            continue

        unsupported = _unsupported_claim(stripped, ctx)
        blocked_classes = _blocked_classes_in_line(stripped, ctx)
        if unsupported:
            blocked_notes.append(unsupported)
            continue
        if blocked_classes:
            for action in blocked_classes:
                blocked_notes.append(f"{action}: {ctx.blocked_actions[action]}")
            continue
        kept_lines.append(line)

    cleaned = "\n".join(kept_lines).strip()
    if blocked_notes:
        lower_cleaned = cleaned.lower()
        if ctx.contradictions and "contradict" not in lower_cleaned and "inconsistent" not in lower_cleaned:
            cleaned += "\n\nTelemetry note: evidence is contradictory; verify field instruments before accepting a single root cause."
        if ctx.safe_actions:
            cleaned += "\n\nPolicy-safe next checks:\n" + "\n".join(f"- {item}" for item in ctx.safe_actions[:4])
        unique = []
        for note in blocked_notes:
            if note not in unique:
                unique.append(note)
        cleaned += "\n\nSafety policy blocked unsupported/unsafe content: " + "; ".join(unique[:3])

    return cleaned or text, blocked_notes


def validate_diagnosis_payload(diagnosis: dict[str, Any], ctx: SafetyContext) -> tuple[dict[str, Any], list[str]]:
    notes: list[str] = []
    out = dict(diagnosis)

    for key in ("probable_cause", "explanation", "recommended_action"):
        value = out.get(key)
        if isinstance(value, str) and value.strip():
            cleaned, blocked = validate_llm_text(value, ctx)
            out[key] = cleaned
            notes.extend(blocked)

    if notes:
        out["_safety_policy"] = {
            "blocked": sorted(set(notes)),
            "states": ctx.states,
            "contradictions": ctx.contradictions,
        }
        if not out.get("recommended_action") and ctx.safe_actions:
            out["recommended_action"] = " | ".join(ctx.safe_actions[:3])

    return out, notes
