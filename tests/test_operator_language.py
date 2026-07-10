"""Golden tests for operator-visible language.

Everything here runs offline. The point is that a jargon regression fails the
build instead of reaching a control room, since the prompt alone cannot guarantee
wording. Tests that need a live model are marked `llm` and deselected by default.
"""

import ast
import json
import pathlib

import pytest

import ai_analyst
import historian_client
import manual_sections
from ai_analyst import (
    MAX_CHAT_ANSWER_WORDS,
    build_current_value_answer,
    build_efficiency_loss_answer,
)
from safety_policy import (
    SafetyContext,
    lint_operator_language,
    lint_payload_language,
    validate_diagnosis_payload,
)

# A live snapshot in the shape the renderers expect: the fuel-flow / rising-pressure
# scenario from plan.md, where the old answer said "fuel flow is NOT pinned".
READING = {
    "tags": {
        "steam_pressure": 12.11,
        "steam_temperature": 181.4,
        "steam_flow": 2280.0,
        "drum_level": 398.0,
        "feedwater_flow": 2290.0,
        "fuel_flow": 151.35,
        "air_flow": 1495.0,
        "o2_percent": 3.1,
        "flue_gas_temp": 205.0,
        "tube_health": 88.0,
        "efficiency": 79.4,
    }
}


# ── The linter itself ───────────────────────────────────────────────────────
@pytest.mark.parametrize(
    "text, expected",
    [
        ("Fuel flow is NOT pinned. The reading is 151.35 m3/hr.", ["pinned"]),
        ("Review the pressure excursion.", ["excursion"]),
        ("Efficiency attribution shows deviated sensors", ["attribution", "deviated"]),
        ("PINNED at max", ["pinned"]),  # case-insensitive
        ("Fuel flow is at the maximum limit of 151.35 m3/hr.", []),
        ("", []),
    ],
)
def test_lint_flags_jargon(text, expected):
    assert lint_operator_language(text) == expected


@pytest.mark.parametrize("text", ["uncapped", "capped", "pinnedness", "excursionists"])
def test_lint_respects_word_boundaries(text):
    """A banned term inside a longer word is a different word."""
    assert lint_operator_language(text) == []


def test_lint_handles_non_string_input():
    assert lint_operator_language(None) == []
    assert lint_operator_language(123) == []


def test_lint_payload_walks_strings_and_lists():
    payload = {"explanation": "pressure excursion", "actions": ["watch deviated flow"]}
    assert lint_payload_language(payload, ("explanation", "actions")) == [
        "deviated",
        "excursion",
    ]


# ── One style contract, one word cap ───────────────────────────────────────
def test_chat_prompt_carries_the_single_word_cap():
    assert f"Max {MAX_CHAT_ANSWER_WORDS} words" in ai_analyst.CHAT_SYSTEM_PROMPT


def test_no_competing_word_cap_survives():
    """The 180-vs-120 conflict must not come back in any prompt string."""
    assert "180 words" not in ai_analyst.CHAT_SYSTEM_PROMPT
    assert MAX_CHAT_ANSWER_WORDS == manual_sections.MAX_CHAT_ANSWER_WORDS


def test_static_core_teaches_plain_words_not_just_bans():
    core = manual_sections.STATIC_CORE
    assert "Start with the direct answer" in core
    assert "at the maximum limit" in core


# ── Deterministic renderers (Tier A) ───────────────────────────────────────
def test_current_value_answer_is_clean_and_keeps_the_number():
    answer = build_current_value_answer("what is the steam pressure right now?", READING)
    assert answer is not None
    assert lint_operator_language(answer) == []
    assert "12.11" in answer


def test_efficiency_loss_answer_is_clean_and_keeps_the_numbers():
    answer = build_efficiency_loss_answer("where am I losing efficiency?", READING)
    assert answer is not None
    assert lint_operator_language(answer) == []
    assert "79.4" in answer
    # Leads with the direct answer, not with theory.
    assert answer.lstrip().startswith("**Efficiency**")


def test_efficiency_loss_answer_drops_the_old_jargon():
    answer = build_efficiency_loss_answer("where am I losing efficiency?", READING)
    for stale in ("Biggest lever", "Accounted heat loss", " pts "):
        assert stale not in answer


def test_status_uses_operator_severity_words():
    answer = build_current_value_answer("what is the steam pressure right now?", READING)
    assert "Status: SAFE" in answer
    assert "dashboard thresholds" not in answer  # the old machine-facing phrasing


def test_two_sided_tag_names_both_alarm_limits():
    """Drum level is dangerous low AND high — naming only one side hides dry-fire risk."""
    answer = build_current_value_answer("what is the drum level?", READING)
    assert "280" in answer and "600" in answer


def test_chat_answers_are_not_json():
    """Operators read prose in chat; JSON is only for cards."""
    answer = build_current_value_answer("what is the steam pressure right now?", READING)
    with pytest.raises(json.JSONDecodeError):
        json.loads(answer)


# ── Card routes ────────────────────────────────────────────────────────────
def _ctx():
    return SafetyContext(intent="diagnose", states={}, latest=READING["tags"])


def test_diagnosis_payload_reports_jargon_without_calling_it_a_safety_block():
    """A wording hit must not masquerade as a blocked unsafe action."""
    payload = {
        "probable_cause": "Fuel flow pinned",
        "severity": "warning",
        "explanation": "The sensor deviated from baseline.",
        "recommended_action": "Watch pressure.",
        "confidence": 80,
    }
    out, notes = validate_diagnosis_payload(payload, _ctx())
    assert out["_language_lint"] == ["deviated", "pinned"]
    assert notes == []
    assert "_safety_policy" not in out


def test_clean_diagnosis_payload_has_no_lint_key():
    payload = {
        "probable_cause": "Steam demand is reducing",
        "severity": "warning",
        "explanation": "Fuel flow is 151.35 m3/hr, below the maximum limit.",
        "recommended_action": "Check the downstream steam header flow.",
        "confidence": 85,
    }
    out, notes = validate_diagnosis_payload(payload, _ctx())
    assert "_language_lint" not in out
    assert notes == []


def test_diagnosis_card_is_valid_json_round_trip():
    payload = {
        "probable_cause": "Steam demand is reducing",
        "severity": "warning",
        "explanation": "Pressure is 12.11 bar. Alert starts at 13.0 bar.",
        "recommended_action": "Check the downstream steam header flow.",
        "confidence": 85,
        "deviated_sensors": [
            {"sensor": "steam_pressure", "value": 12.11, "baseline": 10.0, "severity": "warning"}
        ],
    }
    out, _ = validate_diagnosis_payload(payload, _ctx())
    restored = json.loads(json.dumps(out))
    for key in ("probable_cause", "severity", "explanation", "recommended_action", "confidence"):
        assert key in restored


# ── Hardcoded maintenance strings ──────────────────────────────────────────
# These are built inside a function that needs a historian DB, so lint the source
# literals instead of calling it. The literals are what reach the UI, LLM or not.
OPERATOR_VISIBLE_KEYS = {"task", "impact", "detail", "evidence"}


def _operator_visible_literals(path):
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if not isinstance(node, ast.Dict):
            continue
        for key, value in zip(node.keys, node.values):
            if not (isinstance(key, ast.Constant) and key.value in OPERATOR_VISIBLE_KEYS):
                continue
            for sub in ast.walk(value):
                if isinstance(sub, ast.Constant) and isinstance(sub.value, str):
                    yield key.value, sub.value


def test_maintenance_card_literals_are_clean():
    path = pathlib.Path(historian_client.__file__)
    offenders = [
        (key, text, lint_operator_language(text))
        for key, text in _operator_visible_literals(path)
        if lint_operator_language(text)
    ]
    assert not offenders, f"jargon in operator-visible maintenance strings: {offenders}"


# ── Live-model gate (deselected by default) ────────────────────────────────
@pytest.mark.llm
@pytest.mark.parametrize(
    "question",
    [
        "What are the fuel flow and air flow right now?",
        "Time to reach 13.5 bar?",
        "Why is efficiency down?",
        "What should I do about low O2?",
        "What if I reduce fuel flow by 10%?",
        "Give me the shift report.",
        "What maintenance should I prioritise?",
    ],
)
def test_live_answers_use_operator_language(question, live_chat):
    answer = live_chat(question)
    assert lint_operator_language(answer) == []
    assert len(answer.split()) <= MAX_CHAT_ANSWER_WORDS * 1.25  # soft margin
