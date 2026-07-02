# Book 02 — Safety Limits and Alarms

These are the danger numbers for BOILER-01. Each line is one full rule.
If a live reading crosses a limit here, it is not normal — raise it in the answer.

## Steam pressure limits
- Steam pressure normal = 10 bar.
- Steam pressure HIGH alarm = above 13.0 bar. Pressure is too high, check demand and valves.
- Steam pressure TRIP = 13.5 bar. At 13.5 bar the safety valve lifts (opens) by itself.
- Rule: if steam pressure is above 13.0 bar, do NOT increase fuel or firing. Reduce firing.

## Drum water level limits
- Drum level normal (setpoint) = 400 mm. Full range 0 to 800 mm.
- Drum level LOW alarm = below 280 mm. Check feedwater supply.
- Drum level CRITICAL LOW = below 200 mm. Danger of dry firing and tube rupture. Trip the boiler.
- Drum level HIGH alarm = above 600 mm. Check feedwater control.
- Drum level CRITICAL HIGH = above 720 mm. Danger of water carryover into steam line.
- Rule: if drum level is low, do NOT reduce feedwater. If drum level is high, do NOT increase feedwater.

## Oxygen (O2) limits
- O2 normal = 3.2 %. Safe band = 2 % to 4 %.
- O2 LOW = below 2.0 %. This is dangerous: incomplete burning and carbon monoxide (CO) gas.
- O2 HIGH warning = above 4.0 %. Too much air, wasting heat.
- O2 EXCESS AIR alarm = above 5.5 %. Combustion needs tuning, fuel is being wasted.
- Rule: if O2 is low (below 2 %), do NOT reduce air. First add air or check the O2 sensor.

## Flue gas (chimney) temperature limits
- Flue gas temperature normal = 198 °C.
- Flue gas temperature HIGH warning = above 220 °C. Possible tube fouling starting.
- Flue gas temperature HIGH alarm = above 240 °C. Strong sign of tube fouling; reduce load if it climbs.

## Tube health limits
- Tube health normal = 97 %.
- Tube health DEGRADED = below 80 %. Watch closely.
- Tube health INSPECTION needed = below 70 %. Plan tube inspection and cleaning.

## Efficiency limits
- Efficiency normal = 87 %.
- Efficiency LOW = below 82 %. Something is wasting heat; investigate.
- Efficiency CRITICAL LOW = below 75 %. Big loss of fuel; act soon.

## Flame and safety valve
- Flame status ON (1) = normal, the burner is lit.
- Flame status OFF (0) = FLAME FAILURE. This is an emergency shutdown (ESD). Highest danger.
- Safety valve CLOSED (0) = normal.
- Safety valve OPEN (1) = the valve lifted because pressure was too high. Investigate at once.

## Blocked actions (never advise these)
The AI must never give these unsafe suggestions:
- Do NOT tell the operator to increase feedwater when the drum level is already HIGH.
- Do NOT tell the operator to reduce feedwater when the drum level is LOW.
- Do NOT tell the operator to increase fuel or firing when steam pressure is HIGH.
- Do NOT tell the operator to reduce air when O2 is LOW.
- Do NOT tell the operator to increase fuel/firing when the flame is OFF.
- Do NOT suggest bypass or manual override unless a checked procedure and safe state are confirmed.
- Do NOT suggest PID gain (Kp, Ki, Kd) changes unless the operator asks about PID tuning.

## When two readings disagree (contradiction rule)
Sometimes the meters do not match the physics. In that case, say the data looks
inconsistent and ask to check the field meter. Do not force one root cause.
Examples of contradictions:
- Drum level reads HIGH but feedwater flow is LOW and steam is normal. Suspect a level sensor error, not a real high level.
- Flame reads OFF but fuel flow is not zero. Treat as unsafe meter/control mismatch and verify locally.
- Steam pressure reads HIGH but fuel is LOW and steam flow is normal. Check the pressure sensor or an outlet blockage.
