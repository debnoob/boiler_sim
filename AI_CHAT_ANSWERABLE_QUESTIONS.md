# NEXUS OS — 60 Questions the AI Analyst Can Answer

A demo-ready question bank for BOILER-01. Every question below is phrased to hit
its intended handler in `engine/ai_analyst.py`. Companion to
`AI_CHAT_QUESTION_TAXONOMY.md`, which explains *why* the routing works this way
and where it breaks.

**Tier A** answers are computed from telemetry, historian SQL, or physics — no
LLM in the answer path. Reproducible and fast.
**Tier B** answers come from the local LLM, anchored to an injected physics
brief, safety policy, historian context, and manual excerpts.

Dispatch is first-match-wins, so phrasing matters. Each section notes the cues
the gate requires.

---

## 1. Current sensor values — Tier A
Needs a sensor name plus a present-tense cue (`what is / current / now / show`).
Multi-sensor questions are answered per sensor, in the order asked.

1. What is the drum level?
2. Current steam pressure.
3. Show me the O2 reading.
4. What is the flue gas temperature right now?
5. Tell me the tube health.
6. What is the feedwater temp?
7. Show me steam pressure and drum level.
8. What are the fuel flow and air flow right now?
9. Is the flame proven?
10. What is the current efficiency?

Returns value, baseline delta, percent deviation, and threshold status. Terms
with no sensor (NOx, blowdown, vibration, conductivity …) are named explicitly
rather than silently dropped.

## 2. Efficiency-loss attribution — Tier A
Needs a loss phrase (`heat loss`, `stack loss`, `excess air`, `fouling`) or an
efficiency word plus a loss word. Live state only — historical windows are declined.

11. Where am I losing efficiency?
12. Break down my heat losses.
13. What is the biggest efficiency loss right now?
14. How much is excess air costing me?
15. Give me the stack loss breakdown.
16. Where is my heat rate going?

Returns a ranked split of loss components, the dominant lever, and effective heat rate.

## 3. Consumption and totalizers — Tier A
Needs a consumption verb (`how much / total / burned / consumed / produced`) plus
a flow tag. Defaults to the **current shift** when no window is named.

17. How much fuel did I burn this shift?
18. Total steam produced today.
19. How much feedwater have we consumed since midnight?
20. Show me the totalizers.
21. What was the fuel consumption in the last hour?

Integrates flow rate over the window.

## 4. Alarm and event history — Tier A
Needs an alarm word (`alarm / alert / event / trip / fault / excursion`) **and** a
time or listing cue. A bare "Alarms?" misses the gate.

22. What alarms fired in the last hour?
23. How many critical alerts today?
24. List the trips from yesterday.
25. Were there any faults overnight?
26. Show me the event history for this shift.
27. Any excursions between 11am and 5pm?

## 5. Predictive forecast / time-to-threshold — Tier A
Needs a forecast trigger (`when will / how long until / on track to / will … exceed`)
plus a parseable numeric threshold. Returns nothing if the metric is not trending
toward the threshold.

28. When will tube health hit 70?
29. How long until drum level drops below 280?
30. Time to reach 13.5 bar?
31. Is pressure on track to trip?
32. Will flue gas temp exceed 240 today?
33. Forecast when efficiency falls below 80.

Least-squares slope over the recent window projects an ETA.

## 6. Historical metrics — Tier A
Needs a named tag plus a time expression. Answers the metric and its baseline
comparison only — by design it does **not** explain causes.

34. Average O2 yesterday.
35. Highest flue gas temp this week.
36. What was the efficiency on 4th July?
37. Drum level between 11am and 5pm.
38. Minimum steam pressure last shift.
39. What was the average steam flow today?

## 7. OEE and its factors — Tier A
Needs an OEE term **and** a calculation term. Add "step by step" or "show the
calculation" to get the full working.

40. What is the current OEE?
41. How do I calculate availability?
42. Explain the quality factor.
43. Show the OEE calculation step by step.
44. How much good steam versus bad steam this shift?
45. What is the performance factor and how is it calculated?

## 8. Shift reports — Tier A
Needs the word `shift` plus a report word.

46. Give me the shift report.
47. End of shift summary.
48. Shift handover notes for the night shift.
49. What was the shift report for 4th July?

Returns a structured report card. Future windows return an explanation, not an
empty report.

## 9. Maintenance priorities — Tier A

50. What maintenance should I prioritise?
51. What needs attention first?

Returns a structured priority card.

## 10. Control-loop architecture — Tier A (conceptual)
Needs a relationship word plus a loop/process word. Deliberately does **not**
diagnose live stability.

52. What is the relationship between O2 and air flow?
53. How does the pressure PID control fuel flow?
54. Explain how drum level and feedwater are connected.

## 11. Root cause and diagnosis — Tier B
Live state only. Ask "why" about a **current** condition; historical "why"
questions fall to the historian and return the metric without a cause.

55. Why is efficiency down?
56. What is driving the drum level low?
57. Explain the flue gas temperature rise.
58. Is that a problem, and what do I do?

## 12. Live control-loop stability — Tier B
Anchored to a deterministic actuator-response verdict (correlation of PV error
against actuator output). Covers **three loops only**: pressure→fuel, O2→air,
drum level→feedwater.

59. Is the O2 control loop stable?
60. Is the pressure controller hunting?
61. Is the air damper responding to the O2 PID?
62. Do I have integral windup on the drum level loop?

## 13. What-if simulation — Tier B
The gate requires the literal string `what if` within the first 40 characters.
"If I cut fuel by 10%, what happens?" does **not** simulate.

63. What if I reduce fuel flow by 10%?
64. What if the feedwater pump trips?
65. What if I raise the O2 setpoint to 4%?

## 14. Recommendations and procedures — Tier B
Filtered by the safety policy layer, which blocks disallowed action classes and
flags contradictory telemetry. Advice only — the chat path has no actuation.

66. What should I do about the low O2?
67. Recommended actions for tube fouling.
68. How do I bring pressure back to setpoint?

## 15. Lightweight concepts — Tier B (fast path)
A definition cue with no live-state cue. Skips all context injection.

69. What is heat rate?
70. Define excess air.
71. What is the difference between availability and performance?

---

## Questions to avoid in a demo

These are answered, but poorly — see Section 3 of `AI_CHAT_QUESTION_TAXONOMY.md`.

- **Historical "why":** "Why did efficiency drop yesterday?" returns the metric,
  not a cause. Live diagnosis and historical diagnosis are different features and
  only live is built.
- **Follow-ups without a restated subject:** "And yesterday?" / "Why?" after a
  deterministic answer lose the subject entirely.
- **Cost questions:** "What is this costing me per hour?" — there is no fuel
  price or cost model in the engine.
- **Cross-window comparison:** "Compare this shift to last shift." The historian
  answers one window at a time.
- **Other assets:** every topic is hardcoded to `pumphouse4/boiler/unit01`.
- **Uploaded documents:** RAG retrieval is disabled; uploads have no effect on
  answers.
- **Setpoint writes:** "Set the O2 setpoint to 3.0" produces advice, never a command.
- **Bare keywords:** "OEE?" and "Alarms?" miss their two-cue gates.
- **Broad reviews:** answers are capped at 180 words, so "give me a full plant
  health review" comes back shallow.
