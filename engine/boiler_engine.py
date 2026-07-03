"""
NEXUS OS — Boiler Synthetic Data Engine
Physics-based MQTT publisher
Simulates a real industrial boiler with:
- IAPWS-97 real steam tables
- ODE-based drum boiler dynamics (Åström-Bell model)
- Three PID control loops
- Physics-based fault injection
"""

import paho.mqtt.client as mqtt
import numpy as np
import json
import time
import math
import os
import threading
from datetime import datetime
from iapws import IAPWS97
from scipy.integrate import solve_ivp

from environment import EnvironmentModel

# ============================================================
# MQTT CONFIG
# ============================================================
BROKER_HOST = os.environ.get("MQTT_BROKER_HOST", "localhost")
BROKER_PORT = 1883
PUBLISH_INTERVAL = 1.0  # seconds

# ============================================================
# TOPIC MAP — Unified Namespace Pattern
# ============================================================
BASE = "factory/pumphouse4/boiler"
TOPICS = {
    # Steam Side
    "steam_pressure":     f"{BASE}/unit01/steam/pressure",
    "steam_temperature":  f"{BASE}/unit01/steam/temperature",
    "steam_flow":         f"{BASE}/unit01/steam/flow",

    # Water Side
    "drum_level":         f"{BASE}/unit01/water/drum_level",
    "feedwater_flow":     f"{BASE}/unit01/water/feedwater_flow",
    "feedwater_temp":     f"{BASE}/unit01/water/feedwater_temp",

    # Combustion Side
    "fuel_flow":          f"{BASE}/unit01/combustion/fuel_flow",
    "air_flow":           f"{BASE}/unit01/combustion/air_flow",
    "o2_percent":         f"{BASE}/unit01/combustion/o2_percent",
    "flue_gas_temp":      f"{BASE}/unit01/combustion/flue_gas_temp",

    # Safety
    "flame_status":       f"{BASE}/unit01/safety/flame_status",
    "safety_valve":       f"{BASE}/unit01/safety/safety_valve",
    "tube_health":        f"{BASE}/unit01/safety/tube_health",

    # Derived / KPIs
    "efficiency":         f"{BASE}/unit01/kpi/efficiency",
    "heat_rate":          f"{BASE}/unit01/kpi/heat_rate",

    # Environment (ambient + fuel quality) — drives efficiency/flue-gas drift
    "ambient_temp":       f"{BASE}/unit01/environment/ambient_temp",
    "humidity":           f"{BASE}/unit01/environment/humidity",
    "fuel_lhv":           f"{BASE}/unit01/environment/fuel_lhv",

    # System
    "heartbeat":          f"{BASE}/unit01/system/heartbeat",
    "mode":               f"{BASE}/unit01/system/mode",
    "alerts":             f"{BASE}/unit01/alerts",

    # Closed-loop control (AI → engine command bus, and engine → UI applied-ack)
    "control_applied":    f"{BASE}/unit01/control/applied",
}

# Topic the engine listens on for inbound AI control commands
CONTROL_TOPIC_FILTER = f"{BASE}/control/#"

# ============================================================
# PID CONTROLLER
# ============================================================
class PIDController:
    def __init__(self, Kp, Ki, Kd, output_min, output_max):
        self.Kp = Kp
        self.Ki = Ki
        self.Kd = Kd
        self.integral = 0.0
        self.prev_error = 0.0
        self.out_min = output_min
        self.out_max = output_max

    def reset(self):
        self.integral = 0.0
        self.prev_error = 0.0

    def update(self, setpoint, measurement, dt):
        error = setpoint - measurement
        derivative = (error - self.prev_error) / max(dt, 1e-6)
        self.prev_error = error

        # Tentatively integrate, then anti-windup (conditional integration):
        # if the resulting output saturates, undo this integration step so the
        # integral cannot wind up while the actuator is pinned at a limit. Every
        # real PID does this — without it the loop overshoots and sticks.
        self.integral += error * dt
        output = self.Kp * error + self.Ki * self.integral + self.Kd * derivative
        clamped = max(self.out_min, min(self.out_max, output))
        if clamped != output and self.Ki != 0:
            self.integral -= error * dt
            output = self.Kp * error + self.Ki * self.integral + self.Kd * derivative
            clamped = max(self.out_min, min(self.out_max, output))
        return clamped

# ============================================================
# FAULT INJECTOR
# ============================================================
class FaultInjector:
    def __init__(self):
        self.active_fault = None
        self.severity = 0.0
        # Physics parameter overrides — defaults are healthy values
        self.params = {
            "UA_factor":            1.0,   # heat transfer coefficient multiplier
            "fw_valve_position":    1.0,   # feedwater valve (0=closed, 1=open)
            "air_damper_position":  1.0,   # combustion air damper
            "ignition_active":      True,  # flame on/off
            "level_sensor_bias":    0.0,   # mm offset added to drum level reading
        }

    def reset(self):
        self.active_fault = None
        self.severity = 0.0
        self.params = {
            "UA_factor":            1.0,
            "fw_valve_position":    1.0,
            "air_damper_position":  1.0,
            "ignition_active":      True,
            "level_sensor_bias":    0.0,
        }

    def apply(self, fault_name, severity):
        self.active_fault = fault_name
        self.severity = severity

        # Reset to healthy first, then apply fault
        self.params["UA_factor"]           = 1.0
        self.params["fw_valve_position"]   = 1.0
        self.params["air_damper_position"] = 1.0
        self.params["ignition_active"]     = True
        self.params["level_sensor_bias"]   = 0.0

        if fault_name == "tube_fouling":
            self.params["UA_factor"] = 1.0 - (severity * 0.6)

        elif fault_name == "feedwater_valve_stuck":
            self.params["fw_valve_position"] = max(0.0, 1.0 - severity)

        elif fault_name == "air_damper_fault":
            self.params["air_damper_position"] = max(0.0, 1.0 - severity)

        elif fault_name == "flame_failure":
            self.params["ignition_active"] = False

        elif fault_name == "drum_level_sensor_drift":
            self.params["level_sensor_bias"] = severity * 150.0  # mm

# ============================================================
# BOILER STATE MACHINE
# ============================================================
class BoilerState:
    def __init__(self):
        self.reset()

    def reset(self):
        # Operating mode: 0=Normal, 1=Degrading, 2=Critical, 3=Fault, 4=Ideal
        self.mode = 0
        self.tick = 0
        self.fault_injected = False
        self.degradation_factor = 0.0

        # Stateful degradation accumulator (lets the AI change the *rate*, not just read it)
        self.current_degradation = 0.0

        # Setpoints
        self.steam_pressure_setpoint = 10.0   # bar
        self.drum_level_setpoint     = 400.0  # mm
        self.steam_temp_setpoint     = 180.0  # °C
        self.o2_setpoint             = 3.2    # %

        # ── AI closed-loop control overrides ────────────────────────────
        # When autopilot is inactive these are no-ops, so baseline physics
        # is byte-for-byte unchanged.
        self.ai_autopilot_active     = False
        self.o2_setpoint_override    = None   # AI-commanded O2 target (%)
        self.pressure_setpoint_override = None  # AI-commanded pressure target (bar)
        self.degradation_rate_factor = 1.0    # 1.0 = natural rate; AI lowers to slow fouling
        self.firing_reduction_pct    = 0.0    # informational (applied via pressure setpoint)
        self.soot_blow_pending       = False  # one-shot partial UA recovery
        self.soot_blow_count         = 0

        # ODE state vector: [P_drum (bar), m_water (kg), m_steam (kg)].
        # m_water is set by BoilerPhysicsEngine after steam-table density is available.
        self.ode_state = [10.0, 0.0, 120.0]

        # Derived sensor values updated each tick
        self.steam_pressure    = 10.0
        self.steam_temperature = 180.0
        self.steam_flow        = 2300.0   # kg/hr (steam demand)
        self.drum_level        = 400.0    # mm
        self.feedwater_flow    = 2300.0   # kg/hr
        self.feedwater_temp    = 95.0     # °C
        self.fuel_flow         = 138.0    # m³/hr
        self.air_flow          = 1520.0   # m³/hr
        self.o2_percent        = 3.2
        self.flue_gas_temp     = 198.0
        self.flame_status      = 1
        self.safety_valve      = 0
        self.tube_health       = 97.0
        self.efficiency        = 87.0
        self.heat_rate         = 10500.0

        # Environmental conditions (updated each tick from EnvironmentModel)
        self.ambient_temp      = 25.0     # °C
        self.humidity          = 55.0     # % RH
        self.fuel_lhv          = 35.5     # MJ/m³ (live fuel quality)

        # Lag buffers
        self.pressure_buffer  = [10.0]  * 5
        self.temp_buffer      = [180.0] * 8
        self.fluegas_buffer   = [198.0] * 12

# ============================================================
# PHYSICS ENGINE
# ============================================================
class BoilerPhysicsEngine:
    """
    Drum boiler simulator using:
    - IAPWS-97 real steam tables
    - Åström-Bell ODE model for drum dynamics
    - Three PID control loops
    - Physics-based fault injection
    """

    DT = 1.0               # simulation timestep (s)
    MAX_FW_FLOW = 5000.0   # kg/hr maximum feedwater
    MAX_AIR_FLOW = 3000.0  # m³/hr maximum air
    MAX_FUEL_FLOW = 200.0  # m³/hr maximum fuel
    DRUM_VOLUME_M3 = 3.5   # drum internal volume
    LHV_GAS = 35.5         # MJ/m³ lower heating value natural gas

    def __init__(self):
        self.state = BoilerState()
        self.faults = FaultInjector()
        self.environment = EnvironmentModel()   # ambient + fuel-quality driver
        self.reset_ode_inventory()

        # Three PID loops
        self.pressure_pid  = PIDController(Kp=2.0,  Ki=0.1,  Kd=0.5,
                                           output_min=0, output_max=self.MAX_FUEL_FLOW)
        # Drum-level loop is now the TRIM element of 2-element control (steam-flow
        # feedforward carries the base flow), so its output is a bidirectional
        # correction (kg/hr) around the feedforward, not the absolute feedwater flow.
        self.drumlevel_pid = PIDController(Kp=5.0,  Ki=0.5,  Kd=1.0,
                                           output_min=-2500, output_max=2500)
        self.o2_pid        = PIDController(Kp=1.0,  Ki=0.2,  Kd=0.1,
                                           output_min=0, output_max=self.MAX_AIR_FLOW)

    def gaussian_noise(self, value, sigma_pct=0.008):
        if self.state.mode == 4:
            return value
        sigma = abs(value) * sigma_pct
        return value + np.random.normal(0, sigma)

    def lag_filter(self, buffer, new_value, lag_strength=0.85):
        smoothed = lag_strength * buffer[-1] + (1 - lag_strength) * new_value
        buffer.append(smoothed)
        buffer.pop(0)
        return smoothed

    def water_mass_for_level(self, level_mm, pressure_bar):
        """Convert a 0-800 mm drum level into saturated-water mass."""
        props = self.get_steam_properties(pressure_bar, quality=0)
        rho_l = 1.0 / props["v"] if props["v"] > 0 else 900.0
        level_fraction = min(max(level_mm / 800.0, 0.0), 1.0)
        return level_fraction * self.DRUM_VOLUME_M3 * rho_l

    def reset_ode_inventory(self):
        """Keep initial ODE water inventory consistent with the 400 mm level setpoint."""
        pressure = self.state.steam_pressure_setpoint
        water_mass = self.water_mass_for_level(self.state.drum_level_setpoint, pressure)
        self.state.ode_state = [pressure, water_mass, 120.0]

    def get_steam_properties(self, pressure_bar, temp_C=None, quality=None):
        """Query IAPWS-97 real steam tables."""
        P_mpa = max(pressure_bar / 10.0, 0.001)
        try:
            if quality is not None:
                state = IAPWS97(P=P_mpa, x=float(quality))
            else:
                T_K = (temp_C + 273.15) if temp_C is not None else None
                state = IAPWS97(P=P_mpa, T=T_K)
            return {
                "T_sat": (state.Tsat - 273.15) if state.Tsat else 100.0,
                "h":     state.h  if state.h  else 2700.0,
                "s":     state.s  if state.s  else 6.5,
                "x":     state.x  if state.x is not None else 1.0,
                "v":     state.v  if state.v  else 0.2,
                "rho":   1.0 / state.v if state.v else 5.0,
            }
        except Exception:
            # Fallback if state is outside valid range
            return {"T_sat": 179.9, "h": 2778.0, "s": 6.58,
                    "x": 1.0, "v": 0.194, "rho": 5.15}

    def boiler_odes(self, t, state_vec, inputs):
        """
        Åström-Bell drum boiler ODEs.
        state_vec = [P_drum (bar), m_water (kg), m_steam (kg)]
        inputs    = [Q_fuel (kW), fw_flow (kg/s), steam_demand (kg/s), UA_factor]
        """
        P, m_w, m_s = state_vec
        Q_fuel, fw_flow, steam_demand, UA_factor = inputs

        P_mpa = max(P / 10.0, 0.001)
        try:
            sat_liq  = IAPWS97(P=P_mpa, x=0)
            sat_stm  = IAPWS97(P=P_mpa, x=1)
            h_l = sat_liq.h
            h_g = sat_stm.h
            h_fg = max(h_g - h_l, 1.0)

            # Feedwater enthalpy at 95°C
            fw_state = IAPWS97(P=P_mpa, T=368.15)
            h_fw = fw_state.h
        except Exception:
            h_l, h_g, h_fg, h_fw = 763.0, 2778.0, 2015.0, 398.0

        # Effective heat to steam (UA_factor degrades with tube fouling)
        Q_effective = Q_fuel * UA_factor

        # Evaporation rate (kg/s): heat in / latent heat.
        # Q_effective is kW (kJ/s) and h_fg is kJ/kg, so Q/h_fg is already kg/s.
        # (A previous ×1000 here made evaporation 1000x too small, so drum water
        #  never boiled off and feedwater stalled at ~0.)
        evap_rate = Q_effective / max(h_fg, 1.0)

        # Mass balances
        dm_w_dt = fw_flow - evap_rate
        dm_s_dt = evap_rate - steam_demand

        # Simplified energy-based pressure dynamics
        net_energy = Q_effective - steam_demand * h_g + fw_flow * h_fw
        dP_dt = net_energy / max(m_w * 50.0, 1.0)
        # Clamp pressure rate to avoid instability
        dP_dt = max(-2.0, min(2.0, dP_dt))

        return [dP_dt, dm_w_dt, dm_s_dt]

    def drum_level_from_mass(self, m_water, pressure_bar):
        """Convert water mass to drum level in mm."""
        props = self.get_steam_properties(pressure_bar, quality=0)
        rho_l = 1.0 / props["v"] if props["v"] > 0 else 900.0
        water_volume = m_water / rho_l
        # Drum is cylindrical; level proportional to volume fraction
        level_fraction = min(max(water_volume / self.DRUM_VOLUME_M3, 0.0), 1.0)
        return level_fraction * 800.0  # 0–800 mm range

    def calculate_efficiency(self, flue_gas_temp, o2_percent, UA_factor,
                             ambient_temp=25.0, fuel_lhv=35.5):
        stack_loss      = (flue_gas_temp - 150) * 0.04
        excess_air_loss = max(0, (o2_percent - 3.0)) * 0.8
        fouling_loss    = (1.0 - UA_factor) * 15.0
        # Environmental losses (zero at reference 25 °C / 35.5 MJ/m³ so baseline
        # efficiency is unchanged; colder ambient and leaner gas cost efficiency).
        ambient_loss    = (25.0 - ambient_temp) * 0.08        # shell + cold-air loss
        fuel_quality_loss = (35.5 - fuel_lhv) * 0.4           # leaner gas burns worse
        efficiency = (90.0 - stack_loss - excess_air_loss - fouling_loss
                      - ambient_loss - fuel_quality_loss)
        return max(min(efficiency, 94.0), 45.0)

    def tick(self, scenario="normal", degradation=0.0):
        s = self.state
        fp = self.faults.params
        dt = self.DT

        # ---- Environment (ambient + fuel quality) ----
        if scenario == "ideal":
            ambient_temp, humidity, fuel_lhv = 25.0, 55.0, self.LHV_GAS
        else:
            ambient_temp, humidity, fuel_lhv = self.environment.update(s.tick)
        s.ambient_temp = ambient_temp
        s.humidity     = humidity
        s.fuel_lhv     = fuel_lhv

        # ---- Determine fault/degradation physical parameters ----
        UA_factor = fp["UA_factor"]
        if scenario == "degrading":
            UA_factor = min(fp["UA_factor"], 1.0 - degradation * 0.6)
        elif scenario == "fault" and not fp["ignition_active"]:
            UA_factor = 0.0

        # ---- Load variation (sinusoidal steam demand) ----
        load_variation = 0.0 if scenario == "ideal" else math.sin(s.tick * 0.05) * 80
        demand_noise = 0.0 if scenario == "ideal" else np.random.normal(0, 20)
        steam_demand_kghr = 2300.0 + load_variation + demand_noise
        steam_demand_kgs  = max(steam_demand_kghr / 3600.0, 0.0)

        # ---- Effective setpoints (AI overrides take precedence when set) ----
        pressure_sp = s.pressure_setpoint_override if s.pressure_setpoint_override is not None else s.steam_pressure_setpoint
        o2_sp       = s.o2_setpoint_override       if s.o2_setpoint_override       is not None else s.o2_setpoint

        # ---- PID controllers ----
        # Pressure → fuel flow (lower setpoint = lower firing rate = less thermal stress)
        fuel_flow_cmd = self.pressure_pid.update(
            pressure_sp, s.ode_state[0], dt
        )
        if not fp["ignition_active"]:
            fuel_flow_cmd = 0.0

        # Drum level → feedwater flow — 2-element control:
        #   feedforward: feedwater tracks steam demand (mass balance), so it sits
        #                near steam flow instead of swinging on level error alone
        #   trim:        level PID corrects any inventory imbalance around 400 mm
        # This mirrors real industrial drum-level control and keeps feedwater
        # physically sensible under varying load.
        level_trim_kghr = self.drumlevel_pid.update(
            s.drum_level_setpoint, s.drum_level, dt
        )
        fw_flow_cmd_kghr = steam_demand_kghr + level_trim_kghr
        fw_flow_cmd_kghr = max(0.0, min(self.MAX_FW_FLOW, fw_flow_cmd_kghr))
        fw_flow_cmd_kghr *= fp["fw_valve_position"]
        fw_flow_cmd_kgs = fw_flow_cmd_kghr / 3600.0

        # O2 → air flow (lower O2 target = less excess-air loss = higher efficiency)
        air_flow_cmd = self.o2_pid.update(
            o2_sp, s.o2_percent, dt
        )
        air_flow_cmd *= fp["air_damper_position"]

        # ---- Heat input (kW) from fuel (uses live fuel quality) ----
        fuel_m3_s = fuel_flow_cmd / 3600.0
        Q_fuel_kw = fuel_m3_s * s.fuel_lhv * 1000.0  # kW

        # ---- Integrate ODE over one timestep ----
        inputs = (Q_fuel_kw, fw_flow_cmd_kgs, steam_demand_kgs, UA_factor)
        sol = solve_ivp(
            self.boiler_odes,
            [0, dt],
            s.ode_state,
            args=(inputs,),
            method='RK45',
            max_step=0.5
        )
        s.ode_state = sol.y[:, -1].tolist()

        # Clamp physical limits
        s.ode_state[0] = max(0.5, min(s.ode_state[0], 20.0))   # pressure bar
        max_water_mass = self.water_mass_for_level(800.0, s.ode_state[0])
        min_water_mass = self.water_mass_for_level(20.0, s.ode_state[0])
        s.ode_state[1] = max(min_water_mass, min(s.ode_state[1], max_water_mass))  # water mass kg
        s.ode_state[2] = max(0.0,   min(s.ode_state[2], 5000.0))   # steam mass kg

        P_drum   = s.ode_state[0]
        m_water  = s.ode_state[1]

        # ---- Derive observables from ODE state ----
        steam_props = self.get_steam_properties(P_drum, quality=1.0)

        s.steam_pressure = self.lag_filter(s.pressure_buffer, P_drum, 0.75)
        s.steam_temperature = self.lag_filter(
            s.temp_buffer,
            steam_props["T_sat"] + 5.0 + (0.0 if scenario == "ideal" else np.random.normal(0, 0.5)),
            0.85
        )
        s.steam_flow    = steam_demand_kghr
        s.drum_level    = self.drum_level_from_mass(m_water, P_drum)
        s.feedwater_flow = fw_flow_cmd_kghr
        # Feedwater temp: base 95°C, warmer at high load (more economizer duty) and
        # tracks ambient slightly.
        s.feedwater_temp = (95.0
                            + (steam_demand_kghr / 2300.0 - 1.0) * 20.0
                            + (s.ambient_temp - 25.0) * 0.3
                            + (0.0 if scenario == "ideal" else np.random.normal(0, 1.2)))
        s.fuel_flow      = fuel_flow_cmd
        s.air_flow       = air_flow_cmd

        # O2: drops when air damper faults, rises with excess air
        air_fuel_ratio = (air_flow_cmd / max(fuel_flow_cmd, 0.01)) if fuel_flow_cmd > 0 else 0
        stoich_afr = 11.0
        excess_air_frac = (air_fuel_ratio / stoich_afr) - 1.0 if fuel_flow_cmd > 0 else 0
        s.o2_percent = max(0.5, 21.0 * (excess_air_frac / (1 + excess_air_frac + 1e-6))
                          * fp["air_damper_position"]
                          + (0.0 if scenario == "ideal" else np.random.normal(0, 0.15)))
        if not fp["ignition_active"]:
            s.o2_percent = 20.9  # atmospheric when no combustion

        # Flue gas temp: rises as UA drops (fouling), and also with firing rate,
        # excess air, and ambient temperature — as on a real boiler.
        firing_effect      = (fuel_flow_cmd / 138.0 - 1.0) * 40.0      # more fuel → hotter stack
        excess_air_effect  = max(0.0, s.o2_percent - 3.0) * 3.0        # more excess air → hotter stack
        ambient_effect     = (s.ambient_temp - 25.0) * 0.4            # colder inlet air → cooler stack
        base_fgt = (198.0 + (1.0 - UA_factor) * 85.0
                    + firing_effect + excess_air_effect + ambient_effect)
        s.flue_gas_temp = self.lag_filter(
            s.fluegas_buffer,
            base_fgt + (0.0 if scenario == "ideal" else np.random.normal(0, 2.5)),
            0.90
        )

        # Safety
        s.flame_status = 1 if fp["ignition_active"] and fuel_flow_cmd > 0.1 else 0
        s.safety_valve = 1 if s.steam_pressure > 13.5 else 0

        # Tube health degrades with UA_factor
        s.tube_health = max(
            45.0,
            min(97.0, UA_factor * 97.0 + (0.0 if scenario == "ideal" else np.random.normal(0, 0.1)))
        )

        # KPIs
        s.efficiency = self.calculate_efficiency(
            s.flue_gas_temp, s.o2_percent, UA_factor,
            ambient_temp=s.ambient_temp, fuel_lhv=s.fuel_lhv,
        )
        s.heat_rate  = (s.fuel_flow * s.fuel_lhv * 1000.0) / max(s.steam_flow, 1.0)

        s.degradation_factor = degradation

    def get_readings(self):
        s = self.state
        fp = self.faults.params
        mode_names = {0: "NORMAL", 1: "DEGRADING", 2: "CRITICAL", 3: "FAULT", 4: "IDEAL"}

        # Apply sensor bias fault to drum level reading only
        visible_drum_level = s.drum_level + fp["level_sensor_bias"]

        return {
            "timestamp": datetime.utcnow().isoformat(),
            "unit": "BOILER-01",
            "mode": mode_names.get(s.mode, "NORMAL"),
            "tags": {
                "steam_pressure":    round(self.gaussian_noise(s.steam_pressure,    0.005), 3),
                "steam_temperature": round(self.gaussian_noise(s.steam_temperature, 0.004), 2),
                "steam_flow":        round(self.gaussian_noise(s.steam_flow,        0.008), 1),
                "drum_level":        round(self.gaussian_noise(visible_drum_level,  0.006), 1),
                "feedwater_flow":    round(self.gaussian_noise(s.feedwater_flow,    0.007), 1),
                "feedwater_temp":    round(self.gaussian_noise(s.feedwater_temp,    0.005), 2),
                "fuel_flow":         round(self.gaussian_noise(s.fuel_flow,         0.006), 2),
                "air_flow":          round(self.gaussian_noise(s.air_flow,          0.007), 1),
                "o2_percent":        round(self.gaussian_noise(s.o2_percent,        0.015), 3),
                "flue_gas_temp":     round(self.gaussian_noise(s.flue_gas_temp,     0.005), 2),
                "flame_status":      s.flame_status,
                "safety_valve":      s.safety_valve,
                "tube_health":       round(self.gaussian_noise(s.tube_health,       0.002), 2),
                "efficiency":        round(self.gaussian_noise(s.efficiency,        0.003), 2),
                "heat_rate":         round(self.gaussian_noise(s.heat_rate,         0.004), 1),
                # Environmental readings (drive the efficiency/flue-gas drift)
                "ambient_temp":      round(s.ambient_temp, 2),
                "humidity":          round(s.humidity, 1),
                "fuel_lhv":          round(s.fuel_lhv, 3),
            },
            "degradation_factor": round(s.degradation_factor, 4),
            "tick": s.tick,
            # Environment model state + adjustable parameters (dashboard can read/set)
            "environment": self.environment.snapshot(),
            # Live AI closed-loop control state (UI autopilot badge reads this)
            "control": {
                "autopilot":     bool(s.ai_autopilot_active),
                "o2_setpoint":   round(s.o2_setpoint_override, 2) if s.o2_setpoint_override is not None else round(s.o2_setpoint, 2),
                "pressure_setpoint": round(s.pressure_setpoint_override, 2) if s.pressure_setpoint_override is not None else round(s.steam_pressure_setpoint, 2),
                "degradation_rate_factor": round(s.degradation_rate_factor, 3),
                "firing_reduction_pct": round(s.firing_reduction_pct, 1),
                "soot_blows":    s.soot_blow_count,
            },
        }

# ============================================================
# MQTT PUBLISHER
# ============================================================
class NexusMQTTPublisher:
    def __init__(self):
        self.client = mqtt.Client(client_id="nexus_boiler_engine")
        self.client.on_connect    = self.on_connect
        self.client.on_disconnect = self.on_disconnect
        self.client.on_message    = self.on_message
        self.connected   = False
        self.engine      = BoilerPhysicsEngine()
        self.running     = False

        self.scenario      = "normal"
        self.scenario_tick = 0
        self.max_degradation_ticks = 30

    def reset_to_clean_operation(self, reset_state=False):
        """Return the boiler to a healthy no-fault operating baseline."""
        if reset_state:
            self.engine.state.reset()
            self.engine.reset_ode_inventory()
        s = self.engine.state
        self.engine.faults.reset()
        self.engine.pressure_pid.reset()
        self.engine.drumlevel_pid.reset()
        self.engine.o2_pid.reset()
        s.ai_autopilot_active = False
        s.o2_setpoint_override = None
        s.pressure_setpoint_override = None
        s.degradation_rate_factor = 1.0
        s.firing_reduction_pct = 0.0
        s.soot_blow_pending = False
        s.current_degradation = 0.0
        s.degradation_factor = 0.0

    def on_connect(self, client, userdata, flags, rc):
        if rc == 0:
            print(f"[{self.timestamp()}] ✓ Connected to Mosquitto broker")
            self.connected = True
            self.client.subscribe(CONTROL_TOPIC_FILTER)
            print(f"[{self.timestamp()}] ✓ Subscribed to control topics ({CONTROL_TOPIC_FILTER})")
        else:
            print(f"[{self.timestamp()}] ✗ Connection failed: {rc}")

    def on_disconnect(self, client, userdata, rc):
        print(f"[{self.timestamp()}] ✗ Disconnected from broker")
        self.connected = False

    def on_message(self, client, userdata, msg):
        """Inbound AI control commands on factory/pumphouse4/boiler/control/#."""
        try:
            payload = json.loads(msg.payload.decode())
            if "/control/" in msg.topic:
                self.apply_control(payload)
        except Exception as e:
            print(f"[{self.timestamp()}] ✗ Control message error: {e}")

    def apply_control(self, payload):
        """
        Apply an AI-issued corrective control command to the live physics state.
        These are the only levers an operator/AI could actually pull on a real
        boiler — setpoint trims, firing-rate reduction, and soot blowing. None of
        them magically reverse fouling; they arrest its rate and recover the
        losses that ARE recoverable (excess-air, soot deposits).
        """
        s = self.engine.state

        if "autopilot" in payload:
            s.ai_autopilot_active = bool(payload["autopilot"])
        else:
            # A bare command implies autopilot is engaging
            s.ai_autopilot_active = True

        if payload.get("o2_setpoint") is not None:
            s.o2_setpoint_override = float(payload["o2_setpoint"])
        if payload.get("pressure_setpoint") is not None:
            s.pressure_setpoint_override = float(payload["pressure_setpoint"])
        if payload.get("degradation_rate_factor") is not None:
            s.degradation_rate_factor = max(0.0, min(1.0, float(payload["degradation_rate_factor"])))
        if payload.get("firing_reduction_pct") is not None:
            s.firing_reduction_pct = float(payload["firing_reduction_pct"])
        if payload.get("soot_blow"):
            s.soot_blow_pending = True

        # Live environment adjustment: {"environment": {"ambient_temp_mean": 10, ...}}
        if isinstance(payload.get("environment"), dict):
            self.engine.environment.set_params(**payload["environment"])
            print(f"[{self.timestamp()}] ENVIRONMENT ADJUSTED: {payload['environment']}")

        print(f"[{self.timestamp()}] 🤖 AI CONTROL APPLIED: {payload.get('action','control')} "
              f"| O2sp={s.o2_setpoint_override} Psp={s.pressure_setpoint_override} "
              f"rate×{s.degradation_rate_factor} soot_blow={bool(payload.get('soot_blow'))}")

        # Publish an applied-ack so any consumer can confirm the loop closed
        ack = {
            "applied": True,
            "action": payload.get("action", "control"),
            "o2_setpoint": s.o2_setpoint_override,
            "pressure_setpoint": s.pressure_setpoint_override,
            "degradation_rate_factor": s.degradation_rate_factor,
            "firing_reduction_pct": s.firing_reduction_pct,
            "soot_blow": bool(payload.get("soot_blow")),
            "reason": payload.get("reason", ""),
            "timestamp": datetime.utcnow().isoformat(),
        }
        self.client.publish(TOPICS["control_applied"], json.dumps(ack), qos=1, retain=False)

    def timestamp(self):
        return datetime.now().strftime("%H:%M:%S")

    def publish_tag(self, topic, value):
        payload = json.dumps({
            "value": value,
            "timestamp": datetime.utcnow().isoformat(),
            "unit": "BOILER-01"
        })
        self.client.publish(topic, payload, qos=1, retain=False)

    def publish_all(self, readings):
        tags = readings["tags"]
        for tag_name, value in tags.items():
            if tag_name in TOPICS:
                self.publish_tag(TOPICS[tag_name], value)
        self.client.publish(TOPICS["heartbeat"], json.dumps(readings), qos=1, retain=False)
        self.client.publish(TOPICS["mode"], readings["mode"], qos=1, retain=False)

    def run_scenario(self):
        s = self.engine.state
        s.tick = self.scenario_tick

        if self.scenario == "normal":
            s.mode = 0
            self.engine.faults.reset()
            # Healthy operation — stand down any AI control overrides
            s.ai_autopilot_active = False
            s.o2_setpoint_override = None
            s.pressure_setpoint_override = None
            s.degradation_rate_factor = 1.0
            s.firing_reduction_pct = 0.0
            s.current_degradation = 0.0
            self.engine.tick(scenario="normal", degradation=0.0)

        elif self.scenario == "ideal":
            s.mode = 4
            self.engine.faults.reset()
            s.ai_autopilot_active = False
            s.o2_setpoint_override = None
            s.pressure_setpoint_override = None
            s.degradation_rate_factor = 1.0
            s.firing_reduction_pct = 0.0
            s.soot_blow_pending = False
            s.current_degradation = 0.0
            self.engine.tick(scenario="ideal", degradation=0.0)

        elif self.scenario == "degrading":
            s.mode = 1
            # Integrate degradation so the AI can throttle the accumulation *rate*.
            # With degradation_rate_factor == 1.0 this reproduces the original ramp exactly.
            base_rate = 0.65 / self.max_degradation_ticks
            if self.scenario_tick == 0:
                s.current_degradation = 0.05
            else:
                s.current_degradation = min(
                    s.current_degradation + base_rate * s.degradation_rate_factor, 0.7
                )
            # One-shot soot blowing physically removes deposits → partial UA recovery
            if s.soot_blow_pending:
                s.current_degradation = max(0.05, s.current_degradation - 0.12)
                s.soot_blow_pending = False
                s.soot_blow_count += 1
                print(f"[{self.timestamp()}] 💨 SOOT BLOW applied — UA partially recovered "
                      f"(deg → {s.current_degradation:.3f})")
            degradation = s.current_degradation
            self.engine.faults.apply("tube_fouling", degradation)
            self.engine.tick(scenario="degrading", degradation=degradation)

        elif self.scenario == "critical":
            s.mode = 2
            crit_rate = 0.3 / 60.0
            if self.scenario_tick == 0:
                s.current_degradation = 0.7
            else:
                s.current_degradation = min(
                    s.current_degradation + crit_rate * s.degradation_rate_factor, 1.0
                )
            if s.soot_blow_pending:
                s.current_degradation = max(0.4, s.current_degradation - 0.12)
                s.soot_blow_pending = False
                s.soot_blow_count += 1
                print(f"[{self.timestamp()}] 💨 SOOT BLOW applied (critical) — deg → {s.current_degradation:.3f}")
            degradation = s.current_degradation
            self.engine.faults.apply("tube_fouling", degradation)
            self.engine.tick(scenario="critical", degradation=degradation)

        elif self.scenario == "fault":
            s.mode = 3
            self.engine.faults.apply("flame_failure", 1.0)
            self.engine.tick(scenario="fault", degradation=0.0)

        self.scenario_tick += 1

    def publish_alert(self, severity, message, tag, value, threshold):
        alert = {
            "timestamp": datetime.utcnow().isoformat(),
            "severity":  severity,
            "message":   message,
            "tag":       tag,
            "value":     value,
            "threshold": threshold,
            "unit":      "BOILER-01"
        }
        self.client.publish(TOPICS["alerts"], json.dumps(alert), qos=2, retain=False)
        print(f"[{self.timestamp()}] ALERT [{severity}] {message} | {tag}={value}")

    def check_alarms(self, readings):
        tags = readings["tags"]

        if tags["drum_level"] < 200:
            self.publish_alert("CRITICAL", "Drum Level critically low — risk of dry firing",
                               "drum_level", tags["drum_level"], 200)
        elif tags["drum_level"] < 280:
            self.publish_alert("HIGH", "Drum Level low — check feedwater supply",
                               "drum_level", tags["drum_level"], 280)
        elif tags["drum_level"] > 720:
            self.publish_alert("CRITICAL", "Drum Level critically high — carryover risk",
                               "drum_level", tags["drum_level"], 720)
        elif tags["drum_level"] > 600:
            self.publish_alert("HIGH", "Drum Level high — verify feedwater control",
                               "drum_level", tags["drum_level"], 600)

        if tags["steam_pressure"] > 13.0:
            self.publish_alert("CRITICAL", "Steam pressure high — safety valve may lift",
                               "steam_pressure", tags["steam_pressure"], 13.0)

        if tags["flue_gas_temp"] > 240:
            self.publish_alert("HIGH", "Flue gas temp elevated — possible tube fouling",
                               "flue_gas_temp", tags["flue_gas_temp"], 240)

        if tags["o2_percent"] > 5.5:
            self.publish_alert("MEDIUM", "Excess O2 in flue gas — combustion tuning required",
                               "o2_percent", tags["o2_percent"], 5.5)

        if tags["tube_health"] < 70:
            self.publish_alert("HIGH", "Tube health index critical — inspection required",
                               "tube_health", tags["tube_health"], 70)

        if tags["flame_status"] == 0:
            self.publish_alert("CRITICAL", "FLAME FAILURE — Emergency shutdown initiated",
                               "flame_status", 0, 1)

    def print_status(self, readings):
        tags = readings["tags"]
        mode = readings["mode"]
        deg  = readings["degradation_factor"]
        fault_label = f" | FAULT: {self.engine.faults.active_fault}" if self.engine.faults.active_fault else ""

        print(f"\n{'='*60}")
        print(f"  BOILER-01 | {self.timestamp()} | MODE: {mode} | DEG: {deg:.3f}{fault_label}")
        if mode == "IDEAL":
            print("  IDEAL MODE ACTIVE: clean reference run, no faults, no degradation, stable load")
        print(f"{'='*60}")
        print(f"  Steam:    P={tags['steam_pressure']:.2f} bar  "
              f"T={tags['steam_temperature']:.1f}°C  "
              f"F={tags['steam_flow']:.0f} kg/hr")
        print(f"  Water:    Level={tags['drum_level']:.0f}mm  "
              f"FW={tags['feedwater_flow']:.0f} kg/hr  "
              f"FWT={tags['feedwater_temp']:.1f}°C")
        print(f"  Combust:  Fuel={tags['fuel_flow']:.1f} m³/hr  "
              f"O2={tags['o2_percent']:.2f}%  "
              f"FGT={tags['flue_gas_temp']:.1f}°C")
        print(f"  Safety:   Flame={'ON' if tags['flame_status'] else 'OFF'}  "
              f"SV={'OPEN' if tags['safety_valve'] else 'CLOSED'}  "
              f"TubeHealth={tags['tube_health']:.1f}%")
        print(f"  KPI:      Efficiency={tags['efficiency']:.1f}%  "
              f"HeatRate={tags['heat_rate']:.0f} kJ/kg")
        print(f"{'='*60}")

    def start(self):
        print(f"\n{'='*60}")
        print("  NEXUS OS — Boiler Synthetic Data Engine")
        print("  Physics-based MQTT Publisher v2.0 (IAPWS-97 + ODE + PID)")
        print(f"{'='*60}")
        print(f"  Broker: {BROKER_HOST}:{BROKER_PORT}")
        print(f"  Base topic: {BASE}")
        print(f"  Publish interval: {PUBLISH_INTERVAL}s")
        print(f"{'='*60}\n")

        self.client.connect(BROKER_HOST, BROKER_PORT, keepalive=60)
        self.client.loop_start()

        timeout = 5
        while not self.connected and timeout > 0:
            time.sleep(0.5)
            timeout -= 0.5

        if not self.connected:
            print("ERROR: Could not connect to broker. Is Mosquitto running?")
            return

        self.running = True
        print(f"[{self.timestamp()}] Starting data stream — scenario: {self.scenario}")
        print(f"[{self.timestamp()}] Commands: [i]deal [n]ormal [d]egrade [c]ritical [f]ault [s]top [r]eset [q]uit\n")

        input_thread = threading.Thread(target=self.handle_input, daemon=True)
        input_thread.start()

        while self.running:
            self.run_scenario()
            readings = self.engine.get_readings()
            self.publish_all(readings)
            self.check_alarms(readings)
            self.print_status(readings)
            time.sleep(PUBLISH_INTERVAL)

    def handle_input(self):
        import sys
        import select
        print("[INPUT] Press i/n/d/c/f/s/r/q then Enter to control simulation\n")
        sys.stdout.flush()
        while self.running:
            try:
                if select.select([sys.stdin], [], [], 0.5)[0]:
                    cmd = sys.stdin.readline().strip().lower()
                    if not cmd:
                        continue
                    if cmd == 'n':
                        self.scenario = "normal"
                        self.scenario_tick = 0
                        self.reset_to_clean_operation(reset_state=False)
                        print(f"\n>>> Switched to NORMAL operation\n")
                        sys.stdout.flush()
                    elif cmd == 'i':
                        self.scenario = "ideal"
                        self.scenario_tick = 0
                        self.reset_to_clean_operation(reset_state=True)
                        print(f"\n>>> IDEAL MODE — no faults, no degradation, neutral environment, stable load\n")
                        sys.stdout.flush()
                    elif cmd == 's':
                        self.scenario = "normal"
                        self.scenario_tick = 0
                        self.reset_to_clean_operation(reset_state=True)
                        print(f"\n>>> STOPPED — Switched back to NORMAL simulation\n")
                        sys.stdout.flush()
                    elif cmd == 'd':
                        self.scenario = "degrading"
                        self.scenario_tick = 0
                        print(f"\n>>> Switched to DEGRADING mode — watch efficiency drop\n")
                        sys.stdout.flush()
                    elif cmd == 'c':
                        self.scenario = "critical"
                        self.scenario_tick = 0
                        print(f"\n>>> Switched to CRITICAL mode — drum level dropping\n")
                        sys.stdout.flush()
                    elif cmd == 'f':
                        self.scenario = "fault"
                        self.scenario_tick = 0
                        print(f"\n>>> FAULT INJECTED — flame failure + ESD\n")
                        sys.stdout.flush()
                    elif cmd == 'r':
                        self.scenario = "normal"
                        self.scenario_tick = 0
                        self.reset_to_clean_operation(reset_state=True)
                        print(f"\n>>> System RESET — back to normal\n")
                        sys.stdout.flush()
                    elif cmd == 'q':
                        print(f"\n>>> Shutting down...\n")
                        sys.stdout.flush()
                        self.running = False
            except (EOFError, KeyboardInterrupt):
                break
            except Exception:
                pass

# ============================================================
# ENTRY POINT
# ============================================================
if __name__ == "__main__":
    publisher = NexusMQTTPublisher()
    publisher.start()
