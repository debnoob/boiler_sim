# Book 01 — Normal Values (Healthy Boiler)

These are the normal ("baseline") readings for BOILER-01 when it is healthy.
Each line is one full fact. Compare any live reading to its baseline here.

## Quick normal-value list
- Steam pressure baseline = 10 bar. This is the normal steam pressure.
- Steam temperature baseline = 180 °C. Normal steam temperature.
- Steam flow baseline = 2300 kg/hr. Normal amount of steam made per hour.
- Drum level baseline = 400 mm. Normal water height in the drum. Full range is 0 to 800 mm.
- Feedwater flow baseline = 2300 kg/hr. Normal fresh water going into the boiler.
- Feedwater temperature baseline = 95 °C. Normal temperature of water entering.
- Fuel flow baseline = 138 m³/hr. Normal gas fuel burned per hour.
- Air flow baseline = 1518 m³/hr. Normal combustion air per hour.
- O2 (oxygen) baseline = 3.2 %. Normal leftover oxygen in the flue gas.
- Flue gas temperature baseline = 198 °C. Normal chimney (exhaust) gas temperature.
- Tube health baseline = 97 %. Normal cleanliness/health of the heat tubes.
- Efficiency baseline = 87 %. Normal boiler efficiency.
- Heat rate baseline = 10500 kJ/kg. Normal energy used to make each kg of steam. Lower is better.

## What each meter means, in easy words

Steam pressure = how hard the steam is pushing inside the boiler. Baseline 10 bar.
If pressure rises far above 10 bar it becomes dangerous (see Book 02).

Steam temperature = how hot the steam is. Baseline 180 °C. It follows the pressure;
when pressure goes up, steam temperature goes up too.

Steam flow = how much steam the boiler is sending out to the plant per hour.
Baseline 2300 kg/hr. This is set by how much steam the factory needs (the "load").

Drum level = the water height inside the steam drum, measured in mm. Baseline 400 mm.
Too low means tubes can run dry and crack. Too high means water can carry into the steam line.

Feedwater flow = fresh water pumped into the boiler to replace the water that
became steam. Baseline 2300 kg/hr. It must roughly match the steam flow.

Feedwater temperature = temperature of the incoming water. Baseline 95 °C.

Fuel flow = how much gas fuel is burned per hour. Baseline 138 m³/hr.
More fuel makes more heat. If fuel rises but steam stays the same, energy is being wasted.

Air flow = how much air is blown in to burn the fuel. Baseline 1518 m³/hr.
Air brings oxygen. Too little air = unsafe burning. Too much air = wasted heat.

O2 (oxygen) = the oxygen left over in the exhaust after burning. Baseline 3.2 %.
It tells us if the air-to-fuel mix is correct. Safe band is 2 % to 4 %.

Flue gas temperature = the temperature of the exhaust gas going up the chimney.
Baseline 198 °C. If it rises, it usually means heat is escaping instead of going into steam.

Tube health = a health score (%) for the heat-transfer tubes. Baseline 97 %.
It falls when dirt (soot/scale) builds up on the tubes.

Efficiency = how well fuel energy becomes steam energy. Baseline 87 %.
Higher is better. It falls when heat is lost up the chimney or through dirty tubes.

Heat rate = energy needed to make one kg of steam. Baseline 10500 kJ/kg.
Lower is better. It rises when the boiler is wasting fuel.

Flame status = is the burner flame ON or OFF. Normal is ON (value 1).
OFF (value 0) is an emergency (flame failure).

Safety valve = a spring valve that opens by itself if pressure is too high.
Normal is CLOSED (value 0). OPEN (value 1) means pressure went too high.

## How to say if a reading is normal
Take the live reading, subtract the baseline, and see the difference.
Example: O2 reading 3.3 % vs baseline 3.2 % is only 0.1 % away, so it is normal.
Example: O2 reading 0.47 % vs baseline 3.2 % is far below, so it is a problem.
Small changes near baseline are just normal meter noise, not a fault.
