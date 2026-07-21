"""Runtime physics checks; skipped only when simulator dependencies are absent."""

import pytest

pytest.importorskip("paho.mqtt.client")
pytest.importorskip("iapws")
pytest.importorskip("scipy.integrate")

from boiler_engine import BoilerPhysicsEngine


def test_progressive_corrosion_crosses_minimum_wall_and_starts_leak():
    engine = BoilerPhysicsEngine()

    for tick in range(50):
        severity = min(1.0, 0.12 + tick / 55.0)
        engine.faults.apply("tube_corrosion", severity)
        engine.state.tick = tick
        engine.tick(scenario="corrosion")

    tags = engine.get_readings()["tags"]
    assert tags["feedwater_ph"] < 7.5
    assert tags["dissolved_oxygen"] > 50
    assert tags["corrosion_rate"] > 0.5
    assert tags["tube_wall_thickness"] < 5.5
    assert tags["tube_leak_flow"] > 50
    assert tags["tube_health"] < 90
    assert tags["feedwater_flow"] > tags["steam_flow"]


def test_fouling_does_not_reduce_structural_wall_thickness():
    engine = BoilerPhysicsEngine()
    initial_wall = engine.state.tube_wall_thickness

    for tick in range(10):
        engine.faults.apply("tube_fouling", 0.8)
        engine.state.tick = tick
        engine.tick(scenario="degrading", degradation=0.8)

    assert engine.state.tube_wall_thickness == initial_wall
    assert engine.state.tube_health == pytest.approx(97.0)
