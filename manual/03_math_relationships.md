# Book 03 — The Maths That Links The Meters

These are the simple formulas that connect one meter to another in BOILER-01.
Use them only when the operator asks "how much" or "why". Each formula is one fact.

## Formula 1 — Efficiency
Efficiency (%) = 90 − stack loss − excess air loss − fouling loss.
Efficiency is never above 94 % and never below 45 % in this boiler.
This one formula ties together flue gas temperature, oxygen, and tube health.

Stack loss (%) = (flue gas temperature − 150) × 0.04.
Meaning: hotter chimney gas = more heat thrown away = bigger stack loss.
Example: flue gas 198 °C → (198 − 150) × 0.04 = 1.92 % stack loss.
Example: flue gas 240 °C → (240 − 150) × 0.04 = 3.60 % stack loss.

Excess air loss (%) = (oxygen % − 3.0) × 0.8, but only when oxygen is above 3.0 %.
Meaning: extra oxygen means extra cold air was heated and thrown away.
Example: O2 3.2 % → (3.2 − 3.0) × 0.8 = 0.16 % loss.
Example: O2 6.0 % → (6.0 − 3.0) × 0.8 = 2.40 % loss.

Fouling loss (%) = (1 − UA factor) × 15.
UA factor is the heat-transfer strength. UA factor ≈ tube health % ÷ 97.
Meaning: dirty tubes (low tube health) can't pass heat, so heat is lost.
Example: tube health 97 % → UA = 1.0 → fouling loss = 0 %.
Example: tube health 68 % → UA = 0.70 → fouling loss = (1 − 0.70) × 15 = 4.5 %.

## Formula 2 — Tube health and UA factor
Tube health (%) = UA factor × 97.
UA factor = tube health ÷ 97.
UA factor is 1.0 when tubes are clean and drops toward 0 as soot builds up.
Lower UA factor means less heat moves from the fire into the water.

## Formula 3 — Flue gas temperature and fouling
Flue gas temperature ≈ 198 + (1 − UA factor) × 85.
Meaning: when tubes foul (UA drops), heat cannot enter the water, so it goes up
the chimney instead, and the flue gas gets hotter.
Example: UA 1.0 (clean) → 198 + 0 = 198 °C.
Example: UA 0.70 (fouled) → 198 + 0.30 × 85 = 198 + 25.5 = 223.5 °C.
This is why rising flue gas temperature and falling tube health appear together.

## Formula 4 — Heat rate
Heat rate (kJ/kg) = fuel flow × 35.5 × 1000 ÷ steam flow.
The number 35.5 is the energy in each m³ of gas fuel (MJ/m³).
Meaning: heat rate is fuel energy used per kg of steam. Lower is better.
If fuel goes up but steam stays the same, heat rate goes up = wasting fuel.
Example: fuel 138 m³/hr, steam 2300 kg/hr → 138 × 35.5 × 1000 ÷ 2300 ≈ 2130... 
(the demo baseline heat rate is about 10500 kJ/kg; treat 10500 as normal, higher as worse).

## Formula 5 — Air to fuel ratio
Air-fuel ratio = air flow ÷ fuel flow.
The correct (stoichiometric) ratio for this gas is about 11 to 1.
Meaning: for every 1 part fuel you need about 11 parts air to burn it fully.
More air than 11:1 = extra oxygen in flue gas (high O2) = wasted heat.
Less air than 11:1 = not enough oxygen (low O2) = unsafe, incomplete burning.

## Formula 6 — Heat from fuel
Heat power = fuel flow (in m³ per second) × 35.5 (MJ per m³).
Meaning: burning more fuel makes more heat. This heat boils water into steam.
The control system adds just enough fuel to hold steam pressure at 10 bar.

## One worked example that uses many formulas
Suppose: flue gas = 223.5 °C, O2 = 3.2 %, tube health = 68 %.
Step 1: stack loss = (223.5 − 150) × 0.04 = 2.94 %.
Step 2: excess air loss = (3.2 − 3.0) × 0.8 = 0.16 %.
Step 3: UA factor = 68 ÷ 97 = 0.70; fouling loss = (1 − 0.70) × 15 = 4.5 %.
Step 4: efficiency = 90 − 2.94 − 0.16 − 4.5 = 82.4 %.
So dirty tubes dropped efficiency from 87 % down to about 82 %.
The biggest loss here is fouling loss (4.5 %), so tube cleaning is the main fix.
