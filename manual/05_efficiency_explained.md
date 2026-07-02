# Book 05 — Efficiency Explained (With Worked Sums)

This book helps the AI answer "why is efficiency low?" using real numbers.
Efficiency baseline is 87 %. Efficiency has three main losses. Each loss is one fact.

## The three losses that lower efficiency
Efficiency (%) = 90 − stack loss − excess air loss − fouling loss.
1. Stack loss = heat lost up the chimney because flue gas is hot.
2. Excess air loss = heat lost because too much air was heated and thrown away.
3. Fouling loss = heat lost because dirty tubes cannot pass heat to the water.
To explain low efficiency, work out all three losses and name the biggest one.

## Stack loss detail
Stack loss (%) = (flue gas temperature − 150) × 0.04.
Bigger flue gas temperature = bigger stack loss.
At 198 °C baseline, stack loss is about 1.9 %.
At 240 °C alarm, stack loss is about 3.6 %.
If stack loss is the biggest, the tubes are probably fouling (heat is escaping).

## Excess air loss detail
Excess air loss (%) = (oxygen % − 3.0) × 0.8, only when oxygen is above 3 %.
Bigger oxygen = more unused air heated and wasted.
At O2 3.2 %, excess air loss is only 0.16 %.
At O2 6 %, excess air loss is 2.4 %.
If excess air loss is the biggest, close the air damper a little to lower O2.

## Fouling loss detail
Fouling loss (%) = (1 − UA factor) × 15, where UA factor = tube health ÷ 97.
Lower tube health = higher fouling loss.
At tube health 97 %, fouling loss is 0 %.
At tube health 80 %, UA = 0.82, fouling loss = (1 − 0.82) × 15 = 2.7 %.
At tube health 68 %, UA = 0.70, fouling loss = 4.5 %.
If fouling loss is the biggest, clean the tubes (soot blow now, chemical clean later).

## Heat rate goes with efficiency
Heat rate (kJ/kg) = fuel × 35.5 × 1000 ÷ steam flow. Baseline about 10500. Lower is better.
When efficiency falls, heat rate rises, because more fuel is needed for the same steam.
So low efficiency and high heat rate both mean the same thing: fuel is being wasted.

## Worked example A — mild fouling
Readings: flue gas 223 °C, O2 3.2 %, tube health 68 %.
Stack loss = (223 − 150) × 0.04 = 2.9 %.
Excess air loss = (3.2 − 3.0) × 0.8 = 0.16 %.
Fouling loss = (1 − 0.70) × 15 = 4.5 %.
Efficiency = 90 − 2.9 − 0.16 − 4.5 = 82.4 %.
Biggest loss = fouling (4.5 %). Main action = clean the tubes.

## Worked example B — too much air
Readings: flue gas 205 °C, O2 6.5 %, tube health 96 %.
Stack loss = (205 − 150) × 0.04 = 2.2 %.
Excess air loss = (6.5 − 3.0) × 0.8 = 2.8 %.
Fouling loss = (1 − 0.99) × 15 = 0.15 %.
Efficiency = 90 − 2.2 − 2.8 − 0.15 = 84.9 %.
Biggest loss = excess air (2.8 %). Main action = trim the air damper to lower O2.

## How to answer an efficiency question
1. State the efficiency and how far below 87 % baseline it is.
2. Work out the three losses from the real readings.
3. Name the biggest loss and say what it means in plain words.
4. Give the fix for that biggest loss.
5. Keep it short. Do not give general boiler theory — use the actual numbers.
