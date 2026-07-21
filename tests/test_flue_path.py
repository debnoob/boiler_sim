"""Natural-draft chimney model and deterministic diagnosis contracts."""

import pytest

from deterministic_analyst import classify_root_cause, score_deviations

pytest.importorskip("paho.mqtt.client")
pytest.importorskip("iapws")
pytest.importorskip("scipy.integrate")

from boiler_engine import FlueGasPathModel


def test_natural_draft_baseline_holds_slightly_negative_furnace_pressure():
    flue = FlueGasPathModel()
    state = flue.update(138.0, 1518.0, 198.0, 25.0, 70.0)

    assert -35.0 < state["furnace_pressure_pa"] < -10.0
    assert state["flue_gas_flow_kg_hr"] > 1800.0


def test_blockage_raises_furnace_pressure_and_reduces_flue_flow():
    flue = FlueGasPathModel()
    baseline = flue.update(138.0, 1518.0, 198.0, 25.0, 70.0)
    blocked = flue.update(138.0, 1518.0, 198.0, 25.0, 100.0, resistance_factor=5.0)

    assert blocked["furnace_pressure_pa"] > -5.0
    assert blocked["flue_gas_flow_kg_hr"] < baseline["flue_gas_flow_kg_hr"]


def test_stuck_damper_is_classified_from_command_actual_and_draft_signature():
    tags = {
        "steam_pressure": 10.0, "steam_temperature": 180.0, "steam_flow": 2300.0,
        "drum_level": 400.0, "feedwater_flow": 2300.0, "feedwater_temp": 95.0,
        "fuel_flow": 138.0, "air_flow": 1518.0, "o2_percent": 2.2,
        "flue_gas_temp": 205.0, "efficiency": 82.0, "flame_status": 1,
        "tube_health": 97.0, "tube_wall_thickness": 6.0, "corrosion_rate": 0.02,
        "feedwater_ph": 8.8, "dissolved_oxygen": 10.0, "tube_leak_flow": 0.0,
        "furnace_pressure_pa": 18.0, "flue_gas_flow_kg_hr": 500.0,
        "stack_damper_command_pct": 100.0, "stack_damper_actual_pct": 5.0,
        "stack_draft_pa": -100.0, "stack_exit_temp_c": 205.0,
        "chimney_skin_temp_c": 48.0,
    }

    hypothesis, confidence, evidence = classify_root_cause(tags, score_deviations(tags), {})

    assert hypothesis == "stack_damper_fault"
    assert confidence == "HIGH"
    assert any("command-actual mismatch" in item.lower() for item in evidence)
