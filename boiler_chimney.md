# Boiler And Chimney Simulation Research Brief

## Purpose

This document describes the current NEXUS OS boiler simulator and a proposed
chimney/flue-gas subsystem. It is intended as a handoff to a research assistant
for validation of industrial boiler physics, operating limits, alarm philosophy,
and Honeywell/Rockwell-style HMI conventions.

The project is a training/demo simulator. Do not treat any stated threshold as a
site-approved operating or safety limit. Research should identify where limits
must be configurable and where a licensed boiler, combustion, or process-safety
engineer must approve them.

## Questions For Deep Research

1. What minimum physically credible model should connect a gas-fired fire-tube
   boiler, ducting, induced-draft fan, stack damper, and chimney?
2. Which draft, furnace-pressure, fan, temperature, emissions, and integrity
   signals are normally shown to an operator versus a maintenance engineer?
3. What failure signatures reliably distinguish blocked flue path, ID-fan
   failure, excessive draft, liner/insulation damage, and transmitter failure?
4. How do Honeywell Experion and Rockwell PlantPAx commonly organize overview
   displays, detailed process graphics, faceplates, trends, diagnostics, and
   alarm navigation for a connected process asset?
5. Which values should be configurable instead of hard-coded for a demo?

## Current Architecture

```text
BoilerPhysicsEngine (1 Hz heartbeat)
  -> Mosquitto MQTT
  -> Isolation Forest anomaly detector
  -> deterministic analyst + Groq LLM explanation
  -> Next.js dashboard / historian / forecasting service
```

The LLM is an explainer, never the mathematical detector. The anomaly detector
publishes a score; the deterministic analyst classifies the physics signature;
the LLM turns that approved classification into one operator-facing diagnosis.

Main source files:

- `engine/boiler_engine.py`: IAPWS-97 steam properties, drum ODE, PID loops,
  scenario state machine, MQTT publisher, alarms, and fault injection.
- `engine/anomaly_detector.py`: Isolation Forest on heartbeat features.
- `engine/deterministic_analyst.py`: deviations, trends, root-cause rules, and
  compact physics brief for the LLM.
- `engine/ai_analyst.py`: MQTT event handler, diagnosis debounce, Groq JSON
  incident cards, operator chat, historian-aware answers, and shift reports.
- `engine/historian_client.py`: SQLite raw telemetry and rollups.
- `engine/forecasting_engine.py`: Moirai 2 forecast bands for tube health,
  efficiency, and steam pressure.
- `frontend/`: Next.js dashboard with overview, boiler scene, incidents,
  controls, predictive, reports, and AI-advisor pages.

## Current Boiler Model

### Physical state and control loops

The simulator currently models a drum boiler with:

- IAPWS-97 properties for saturated water and steam.
- ODE state: drum pressure, water mass, and steam mass.
- Pressure PID controlling fuel flow.
- Two-element drum-level control: steam-flow feedforward plus level-PID trim.
- O2 PID controlling combustion air.
- Gaussian sensor noise and lag buffers for pressure, steam temperature, and
  flue-gas temperature.
- Ambient temperature, humidity, and fuel lower heating value disturbance.

The present flue-gas temperature is a derived heat-loss signal. It increases
with firing rate, excess air, ambient conditions, and reduced heat transfer from
fouling. It is not yet connected to a physical chimney draft model.

### Existing scenarios and faults

Terminal commands currently include:

| Scenario | Key | Behavior |
|---|---:|---|
| Ideal | `i` | Clean reference run with stable load and neutral environment |
| Normal | `n` | Normal closed-loop boiler operation |
| Degrading | `d` | Progressive tube fouling; UA falls, stack temperature rises, efficiency falls |
| Critical | `c` | Accelerated fouling condition |
| Corrosion | `k` | Chemistry excursion, permanent wall loss, then tube leakage |
| Flame fault | `f` | Flame failure / emergency shutdown |
| Reset | `r` | Clean reset |

Other injectable physics faults include feedwater-valve restriction, air-damper
fault, and drum-level sensor bias.

### Fouling versus corrosion

These are deliberately independent states:

- Fouling changes `UA_factor`, flue-gas temperature, efficiency, and heat rate.
  Soot blowing can partially recover it.
- Corrosion changes tube wall thickness permanently. It is driven by feedwater
  pH and dissolved oxygen. Once wall thickness crosses a demo threshold, a tube
  leak removes water and energy from the drum model. Soot blowing cannot repair
  wall thickness.

The corrosion demo accelerates time: 30 simulation seconds represent one
equivalent operating year. This is a visualization device, not a real corrosion
rate model.

## Current Telemetry

All signals are sent as individual MQTT tags where applicable and together in a
heartbeat payload under:

`factory/pumphouse4/boiler/unit01/system/heartbeat`

Key current tags:

| Area | Signals |
|---|---|
| Steam | pressure, temperature, flow |
| Water | drum level, feedwater flow, feedwater temperature |
| Chemistry and integrity | feedwater pH, dissolved oxygen, corrosion rate, tube wall thickness, estimated tube leak flow, tube health |
| Combustion | fuel flow, air flow, O2, flue-gas temperature |
| Safety | flame status, safety valve |
| KPIs | efficiency, heat rate |
| Environment | ambient temperature, humidity, fuel LHV |

`tube_health` now means structural pressure-boundary integrity, not fouling.

## Current Detection, Diagnosis, History, And Forecasting

### Anomaly detector

The Isolation Forest uses 40 healthy `NORMAL` or `IDEAL` heartbeats before
training. It currently uses these features:

```text
steam_pressure, steam_temperature, drum_level, fuel_flow,
flue_gas_temp, efficiency, feedwater_ph, dissolved_oxygen,
tube_wall_thickness, corrosion_rate, tube_leak_flow
```

Incomplete heartbeats are skipped rather than converted to fake zero values.
The detector publishes `score`, `is_anomaly`, and raw `decision_score` to:

`factory/pumphouse4/boiler/unit01/ai/anomaly_score`

The current demo threshold is `decision_score < 0.05`. It needs validation
against longer normal/fault runs before being considered calibrated.

### Deterministic analyst

Root-cause rules precede the LLM. Existing classifications include tube fouling,
corrosion/leak, combustion problems, feedwater faults, PID issues, flame failure,
and sensor drift. Corrosion is identified from the chemistry -> corrosion-rate ->
wall-loss -> leak/inventory chain. The LLM receives the physics brief and should
not invent a separate cause.

### Historian and forecasting

The historian stores typed raw telemetry plus rollups in local SQLite. Forecasts
use Moirai 2 or a statistical fallback. The Moirai adapter pads early histories
to its configured context window and maps the model's native quantiles to p10,
p50, and p90 bands.

## Current Dashboard

The overview page shows boiler KPIs, alarm state, live trends, reliability
runway, anomaly score, and corrosion/integrity metrics. The `Live Tags` panel
contains water chemistry and tube integrity as a dedicated section. The existing
Three.js boiler scene already has a visual stack, but it is only colored from
flue-gas temperature and has no physical chimney telemetry or interaction.

## Proposed Chimney / Flue-Gas Subsystem

### Architectural decision

Do not build the chimney as an unrelated simulator or separate service. Add a
`FlueGasPathModel` (or similarly named class) inside `BoilerPhysicsEngine`.
The boiler remains the process unit; the chimney is a coupled exhaust subsystem.
It publishes through the same heartbeat and MQTT namespace.

```text
fuel + combustion air
  -> furnace heat release and flue-gas generation
  -> boiler heat transfer / economizer (optional later)
  -> duct resistance + damper + ID fan + chimney
  -> furnace draft feedback
  -> combustion air, O2, CO, efficiency, flame stability, interlocks
```

### Minimum physical model

Use a low-order, stable model rather than CFD:

1. Estimate flue-gas mass flow from fuel and air flow.
2. Estimate flue-gas density from pressure and temperature.
3. Calculate natural stack draft from stack height and the density difference
   between ambient air and flue gas:

```text
delta_P_stack ~= g * stack_height * (rho_ambient - rho_flue_gas)
```

4. Calculate path pressure loss from a configurable resistance coefficient,
   duct area, gas density, damper position, and fouling/blockage factor:

```text
delta_P_loss ~= K_total * rho * velocity^2 / 2
```

5. Add ID-fan pressure rise based on actual fan speed and degradation/health.
6. Calculate furnace pressure/draft from fan contribution plus natural draft
   minus path loss. Use negative pressure as normal operation.
7. Add a draft PID that commands ID-fan speed to a configurable furnace-draft
   setpoint. The next tick's draft influences air delivery and combustion.

Keep the first version simple, transparent, and parameterized. Do not claim it
is a design calculation for a real stack.

### Proposed state and telemetry

Publish individual values under `.../unit01/flue/...` and
`.../unit01/chimney/...`, while retaining them in the heartbeat.

| Asset | Suggested tags | Why |
|---|---|---|
| Furnace/flue path | `furnace_draft_pa`, `flue_gas_flow_kg_hr`, `flue_gas_temp` | Core process state |
| ID fan | `id_fan_command_pct`, `id_fan_speed_pct`, `id_fan_status`, `id_fan_health_pct` | Control and equipment diagnosis |
| Damper | `stack_damper_position_pct`, `stack_damper_command_pct` | Restriction and actuator diagnosis |
| Chimney | `stack_draft_pa`, `stack_exit_temp_c`, `chimney_skin_temp_c`, `liner_health_pct` | Draft, heat loss, and integrity |
| Emissions/CEMS | `co_ppm`, `nox_ppm`, optional `opacity_pct` | Combustion quality and environmental alarms |

For natural-gas firing, CO is a stronger early abnormal-combustion signal than
opacity. Treat opacity as optional unless the simulation also models soot or
alternative fuel.

### Proposed faults and expected signatures

| Fault | Direct model change | Expected operator signature |
|---|---|---|
| Duct/stack blockage or damper stuck | Resistance increases | Draft becomes less negative, furnace pressure rises, ID fan command/speed rises, O2 falls, CO rises |
| ID-fan degradation/trip | Fan head or actual speed decreases | Command/actual mismatch, draft collapse, reduced flue flow, furnace-pressure alarm |
| Excess draft | Fan speed high or damper too open | Furnace pressure too negative, O2/excess air high, efficiency lower |
| Stack liner/insulation damage | Skin heat loss rises; liner health falls | Skin temperature high, efficiency penalty, integrity trend deteriorates |
| Stack breach / air ingress | Local resistance/leak model | Draft/flow disturbance and O2 inconsistency; diagnose carefully |
| Draft transmitter drift | Reading-only bias | Process physics contradicts reported draft; no matching fan/flow/combustion signature |
| CEMS analyzer drift | Reading-only CO/NOx bias | Emission value conflicts with O2, draft, fuel, and flame behavior |
| Wind or rain-cap disturbance | Transient external draft disturbance | Short-lived draft oscillation; should not be labelled equipment failure without persistence |

### Controls and safety simulation

Add a draft PID and expose a draft setpoint and ID-fan command/actual state. A
future operator-control command can include a bounded draft-setpoint trim, but
the first release should be monitoring-first.

Proposed interlock behavior, subject to research and configuration:

- ID fan proven before fuel-enable permissive.
- Furnace pressure high-high: controlled fuel trip in the simulator.
- Sustained insufficient draft or high CO: reduce firing, then controlled trip
  if the condition persists.
- Fan trip while firing: flame-loss / unsafe-draft sequence.

Do not hard-code real safety setpoints. Store demo alarm, trip, persistence, and
hysteresis values in one configuration object.

## Downstream Changes Required

1. Add chimney tags to TypeScript telemetry types, MQTT topic map, historian
   numeric tags/schema migration, baseline/unit/alias dictionaries, exports,
   and reports.
2. Add only physically measured chimney signals to the Isolation Forest. Do
   not use LLM-generated or aggregate risk fields as ML features.
3. Add deterministic hypotheses before generic degradation:
   `flue_path_restriction`, `id_fan_fault`, `excess_draft`,
   `chimney_liner_damage`, `draft_transmitter_fault`, and `cems_sensor_fault`.
4. Add thresholds, trend rules, corrective actions, and safety-policy language.
5. Preserve the existing event-driven rule: anomaly detector detects, rules
   classify, LLM explains one debounced incident event.
6. Add focused engine, detector, analyst, historian, and UI tests for each
   fault signature and reset/recovery behavior.

## Recommended HMI Design

Use a hierarchy rather than placing every chimney signal on the boiler overview.

### Overview page

Add a compact `Flue Path` status tile with:

- furnace draft,
- ID-fan state or actual speed,
- stack exit temperature,
- CO state,
- a single abnormal-state color and active alarm count.

The overview should answer: "Is the flue path safe and available?"

### Boiler scene

Make the existing stack clickable. Its state should reflect draft/fan/temperature
and alarm state, not only stack temperature. Selecting it should navigate to the
detailed flue-gas page or open a concise faceplate.

### New detailed page: `/flue-gas`

Create a dedicated page because draft, fan, damper, emissions, and integrity are
too dense for the existing overview. Suggested layout:

```text
furnace -> boiler outlet -> duct -> ID fan -> stack
             process graphic with live flow/draft states

selected asset faceplate | active alarms / interlocks
trend strip              | draft, fan command vs actual, O2, CO, stack temp
maintenance strip        | fan health, liner health, skin temperature, history
```

The page should support a normal/abnormal process display, equipment faceplate,
alarm navigation, trends, diagnostics, and maintenance context. It should not
be a decorative dashboard card collection.

### Incidents and reports

Group affected equipment as `CHIMNEY-01`, `IDF-01`, `STACK-DAMPER-01`, or
`CEMS-01`. Incident cards should state the causal chain and whether the action
is operating, maintenance, instrumentation, or safety-related.

## Vendor HMI Convention To Validate

The intended design follows common Honeywell Experion and Rockwell PlantPAx
conventions, without copying their branding or screens:

- Overview display: restrained high-performance graphic; color reserved for
  abnormal conditions.
- Unit detail: process flow, normal operating state, and navigation to assets.
- Faceplate: mode, command/actual, permissives/interlocks, alarm state,
  diagnostics, and maintenance condition for one object.
- Alarm summary: priority, acknowledgement, timestamp, state, and direct
  navigation to the affected process graphic/faceplate.
- Trend and event history: available from the asset rather than hidden behind
  a generic dashboard score.

Research should verify this against the current PlantPAx Process Object Library
documentation and Honeywell Experion HMI/alarm-management documentation. Public
vendor web endpoints were not reliably retrievable in the local research
environment, so exact current terminology and screenshots were not asserted.

## Suggested Delivery Phases

### Phase 1: Visible, safe draft model

- Add `FlueGasPathModel`, natural draft, fan contribution, pressure loss, and
  furnace-draft PID.
- Add draft/fan/damper/stack telemetry and basic alarms.
- Add a `Flue Path` summary on overview and clickable stack in the boiler scene.
- Validate normal startup, load response, and ID-fan trip.

### Phase 2: Fault diagnosis and detailed HMI

- Implement blockage, fan degradation, excess draft, and transmitter drift.
- Add detector features, deterministic hypotheses, incident actions, historian
  support, and `/flue-gas` detailed page.
- Test every fault against its expected multi-signal signature.

### Phase 3: Emissions and integrity

- Add CO/NOx, CEMS drift, stack liner/insulation health, skin temperature, and
  wind disturbance.
- Add trend-based maintenance and forecasting for fan and liner health.
- Validate alarm priority, persistence, hysteresis, and reset behavior.

## Acceptance Criteria

The chimney integration is complete when:

1. Changing load, ambient temperature, fan speed, damper position, or stack
   resistance changes draft and at least one connected boiler metric.
2. Each injected chimney fault has a distinct, explainable multi-tag signature.
3. A blockage does not look identical to an ID-fan failure or sensor drift.
4. The anomaly detector sees measured chimney signals only and triggers the
   existing single-diagnosis event flow.
5. The dashboard gives immediate abnormal-state awareness on the overview and
   detailed operation/diagnosis on `/flue-gas`.
6. Existing boiler, fouling, corrosion, historian, forecasting, and incident
   behavior remains backward compatible.
7. All constants are documented as demo defaults and are configurable.
