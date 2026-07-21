"""Corrosion fault contracts across physics diagnosis and telemetry."""

from deterministic_analyst import build_physics_brief, classify_root_cause, score_deviations


def _corrosion_tags(**overrides):
    tags = {
        "steam_pressure": 9.8,
        "steam_temperature": 179.0,
        "steam_flow": 2300.0,
        "drum_level": 360.0,
        "feedwater_flow": 2850.0,
        "feedwater_temp": 95.0,
        "fuel_flow": 145.0,
        "air_flow": 1520.0,
        "o2_percent": 3.2,
        "flue_gas_temp": 200.0,
        "tube_health": 78.0,
        "tube_wall_thickness": 4.82,
        "corrosion_rate": 0.92,
        "feedwater_ph": 5.9,
        "dissolved_oxygen": 190.0,
        "tube_leak_flow": 950.0,
        "efficiency": 80.0,
        "flame_status": 1,
    }
    tags.update(overrides)
    return tags


def test_corrosion_signature_has_priority_over_general_degradation():
    tags = _corrosion_tags()
    deviations = score_deviations(tags)
    hypothesis, confidence, evidence = classify_root_cause(tags, deviations, {})

    assert hypothesis == "tube_corrosion"
    assert confidence == "HIGH"
    assert any("permanent pressure-boundary loss" in item for item in evidence)
    assert any("tube leak" in item.lower() for item in evidence)


def test_chemistry_excursion_detects_corrosion_before_leak():
    tags = _corrosion_tags(
        tube_health=95.0,
        tube_wall_thickness=5.88,
        tube_leak_flow=0.0,
        corrosion_rate=0.55,
    )
    hypothesis, confidence, _ = classify_root_cause(tags, score_deviations(tags), {})

    assert hypothesis == "tube_corrosion"
    assert confidence == "MEDIUM"


def test_fouling_signature_does_not_require_structural_health_loss():
    tags = _corrosion_tags(
        flue_gas_temp=230.0,
        efficiency=78.0,
        tube_health=97.0,
        tube_wall_thickness=6.0,
        corrosion_rate=0.02,
        feedwater_ph=8.8,
        dissolved_oxygen=10.0,
        tube_leak_flow=0.0,
    )
    hypothesis, _, _ = classify_root_cause(tags, score_deviations(tags), {})

    assert hypothesis == "tube_fouling"


def test_incident_brief_recommends_shutdown_when_corrosion_is_leaking():
    samples = [{"tags": _corrosion_tags()} for _ in range(8)]
    brief = build_physics_brief(samples)

    assert brief.primary_hypothesis == "tube_corrosion"
    assert any("controlled shutdown" in action for action in brief.corrective_actions)
