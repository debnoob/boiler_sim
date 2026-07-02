# Book 06 — Maintenance Priority Rules (This Week's Jobs)

Use these rules to rank repair jobs when the operator asks
"what should maintenance do this week?" or "what to prioritise?".
Rank the most dangerous job as Priority 1. Each rule is one full fact.

## Urgency words to use
- URGENT / Now: safety risk, act immediately.
- IMPORTANT / This shift: act during this shift.
- MONITOR / This week: plan the job this week.
- ROUTINE / Next outage: keep watching, fix at the next planned shutdown.

## Rule 1 — Safety valve lifted (highest priority)
If the safety valve opened (value 1) in the period, this is the top job, do it NOW.
Team: Mechanical + Operations.
Why: an open safety valve means pressure went above the set point. Confirm the valve
reseated and inspect it before running further.

## Rule 2 — Low oxygen (very urgent)
If the lowest O2 in the period was below 2.0 %, make this URGENT, this shift.
Team: I&C + Combustion.
Why: low oxygen means incomplete burning and carbon monoxide risk. Calibrate the O2
analyser, check the air path, damper feedback, and fuel-air trim before raising load.

## Rule 3 — High steam pressure
If the highest steam pressure was above 13.0 bar, make this IMPORTANT, this week.
Team: I&C + Operations.
Why: high pressure eats into the margin to the 13.5 bar safety valve set point.
Check the pressure sensor, demand swings, and any outlet blockage.

## Rule 4 — Drum level out of safe band
If the drum level went below 280 mm or above 600 mm, make this IMPORTANT, this week.
Team: I&C + Mechanical.
Why: level swings risk low-water trips or water carryover. Compare gauge glass to the
transmitter, check feedwater valve feedback, pump recirculation, and impulse lines.

## Rule 5 — Heat transfer / tube health
Trigger this job if any is true: lowest tube health below 96.5 %, OR highest flue gas
above 220 °C, OR average efficiency below 85 %. Make it MONITOR, this week.
Team: Mechanical.
Why: rising flue gas with falling tube health means fireside fouling and lost efficiency.
Plan a fireside inspection and cleaning review.

## Rule 6 — Many alerts or anomalies
If there were several alerts or anomaly events, add a triage job, this week.
Team: I&C.
Why: repeated events hide real faults and cause alarm fatigue. Group events by tag,
check the noisiest meter, and close old alarms before changing any controls.

## Rule 7 — 30-day slow decline (trend jobs)
Look at the last 30 days, not just this week.
If tube health dropped 0.5 points or more over 30 days, plan to project tube life and
pre-stage cleaning; if it dropped 3 points or more, bring the job into this week.
If efficiency drifted down 1 point or more over 30 days, add a job to find the loss
(check O2 trim, flue gas temperature, and tube health). Team: Reliability / Performance.

## How to rank when several apply
1. Safety valve lift or flame failure = always Priority 1 (Now).
2. Low O2 below 2 % = Priority 1 or 2 (this shift).
3. High pressure above 13 bar = next.
4. Drum level out of band = next.
5. Tube fouling / low efficiency = next.
6. Alert triage and slow trends = lower, this week.
Always give the most dangerous first and give a short "Why" with the real number.

## Important note
These are inspection and work-order priorities for people to do.
They are NOT automatic control changes. The AI suggests jobs; humans do them safely.
