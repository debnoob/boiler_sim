# Book 04 — Cause And Effect Chains (How To Reason)

This is the most important book for thinking. Each fault below shows the SIGNS
(what the meters show), the CHAIN (why one thing leads to another), and the FIX.
Check faults in this order — the top one is most dangerous.

## Order of checking (most dangerous first)
1. Flame failure. 2. Tube fouling. 3. Low oxygen (incomplete burning).
4. High oxygen (excess air). 5. Low drum water level (feedwater starvation).
6. Air damper fault. 7. Steam demand drop (high pressure). 8. Feedwater valve fault.
9. Sensor drift. 10. General slow wear.

## Fault 1 — Flame failure (emergency)
Signs: flame status = OFF (0). Oxygen jumps up near 21 % (same as normal air).
Chain: the burner flame goes out → no fuel is burning → no oxygen is used →
oxygen rises to about 20.9 % (the amount in fresh air) → boiler must shut down (ESD).
Fix: confirm all fuel valves are CLOSED. Purge the furnace before any restart.
Check the igniter, the flame scanner, and fuel pressure. This is the top emergency.

## Fault 2 — Tube fouling (dirty tubes)
Signs: flue gas temperature RISING (above 220 °C), tube health FALLING,
efficiency FALLING, and often fuel flow rising to hold the same steam.
Chain: soot or scale coats the tubes → heat cannot pass into the water (UA drops) →
that heat escapes up the chimney → flue gas temperature rises → tube health score
falls → efficiency falls → to keep steam up, more fuel is burned → fuel is wasted.
Why it fits: flue gas up AND tube health down at the same time is the fouling fingerprint.
Fix: start soot blowing to clean deposits. Reduce firing 10-15 % to lower stress.
Lower O2 setpoint to about 2.8 % to save fuel. Plan chemical tube cleaning at next outage.
If flue gas passes 240 °C, reduce load further.

## Fault 3 — Low oxygen / incomplete combustion (dangerous)
Signs: oxygen BELOW 2.0 %. Fuel may be high. Flame still ON.
Chain: too little air OR too much fuel → not enough oxygen to burn fully →
oxygen drops below 2 % → fuel burns incompletely → poisonous carbon monoxide (CO)
forms and soot builds up → danger to the boiler and to workers.
Fix: this is urgent. First check if the O2 sensor is faulty (old calibration gives
a wrong low reading). If the sensor is fine, open the air damper to add air, and
reduce fuel a little. Do NOT increase load until O2 is above 2 % for at least 60 seconds.
Never reduce air when oxygen is already low.

## Fault 4 — High oxygen / excess air
Signs: oxygen ABOVE 4 % (alarm above 5.5 %), efficiency a bit low, air-fuel ratio high.
Chain: too much air is blown in → extra oxygen passes through unused →
that extra cold air is heated and thrown up the chimney → heat is wasted →
efficiency falls and stack loss rises.
Fix: close the air damper a little to bring O2 into the 2-4 % band.
Check the O2 sensor calibration. After fixing, flue gas temperature should fall toward 198 °C.

## Fault 5 — Low drum water level (feedwater starvation)
Signs: drum level BELOW 280 mm (critical below 200 mm). Feedwater flow often low. Level still falling.
Chain: feedwater valve stuck or pump weak → less water enters than steam leaves →
water level in the drum falls → if it keeps falling, tubes are no longer covered by water →
tubes overheat and can crack (tube rupture). This is a serious safety risk.
Fix: increase feedwater to the maximum safe rate. Check the feedwater valve and pump.
If the level drops below 200 mm, TRIP the boiler at once. Never reduce feedwater when level is low.

## Fault 6 — Air damper fault
Signs: oxygen very low (below 1.5 %) even though the flame is on and fuel is normal.
Chain: the air damper is stuck or blocked → air cannot get in → oxygen falls →
burning becomes unsafe even though fuel is normal.
Fix: check the damper actuator position against its command. Check the blade is not jammed.
Fire on manual with reduced fuel until it is fixed. Do NOT raise load with a stuck damper.

## Fault 7 — Steam demand drop (pressure rising)
Signs: steam pressure ABOVE 10 bar and rising. Steam flow (load) has dropped.
Chain: the factory suddenly needs less steam → but fuel is still burning the same →
extra heat has nowhere to go → pressure builds up → if it reaches 13.5 bar the safety valve lifts.
Fix: verify the downstream steam demand. Lower the pressure setpoint to reduce firing.
Watch the safety valve margin. Do NOT increase fuel when pressure is high.

## Fault 8 — Feedwater valve fault
Signs: feedwater flow very low (below 70 % of normal) BUT drum level is still holding.
Chain: the feedwater control valve may be stuck in bypass → the meter reads low flow
while water still reaches the drum some other way → level holds but the reading is odd.
Fix: check the valve actuator air and signal. Keep level above 280 mm. Repair the actuator.
If the numbers do not agree, say the data looks inconsistent and verify locally.

## Fault 9 — Sensor drift
Signs: efficiency looks low but no other meter explains it, and O2 is below 5 %.
Chain: a meter slowly reads wrong over time (drift) → it shows a fault that is not real.
Fix: compare the gauge glass to the drum_level meter. If they differ by more than 20 mm,
suspect a level sensor error. Operate on the gauge glass and calibrate the transmitter.

## Fault 10 — General slow wear
Signs: efficiency or tube health slightly below normal, no single strong cause.
Chain: many small losses add up slowly over weeks → gentle drop in performance.
Fix: review the trend. If efficiency has fallen more than 5 % from baseline, plan an inspection.
Check all sensor calibration certificates. Book a maintenance inspection within 48 hours.

## The key linked idea to remember
Fuel makes heat. Heat should go into water to make steam. Anything that stops heat
reaching the water (dirty tubes, wrong air) sends heat up the chimney instead.
So: flue gas temperature UP + efficiency DOWN almost always means heat is being lost,
usually from tube fouling or wrong air. Oxygen tells you if the air is right.
Drum level and pressure are safety numbers — protect them first.
