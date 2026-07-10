# NEXUS OS — AI Analyst Question Taxonomy

Reference notes for client demos. Organised by the **answer path** a question actually takes inside `engine/ai_analyst.py`, because that is what determines whether an answer is deterministic (physics/SQL, always correct) or generative (LLM, best-effort).

Two tiers matter to a client:

- **Tier A — Deterministic handlers.** Computed from telemetry, historian SQL, or physics. No LLM in the answer. Reproducible, auditable, fast.
- **Tier B — Generative path.** Local LLM (Ollama) answers, anchored to an injected physics brief, safety policy, historian context, and manual excerpts. Good, but bounded by a 180-word cap and the model's reasoning.

Dispatch is **first-match-wins**, in the order below. A question that trips an earlier gate never reaches a later one. Most of the failure modes in Section 3 are ordering artifacts, not model weakness.

---

## 1. Tier A — Deterministic handlers

### 1.1 Shift reports
Gate: `_is_shift_report_request` — needs the word `shift` plus a report word.

- "Give me the shift report."
- "End of shift summary."
- "Shift handover notes for the night shift."
- "What was the shift report for 4th July?"
- "Night shift summary yesterday."

Returns a structured report card. Past windows are resolved by date parsing; future windows return an explanation rather than an empty report.

### 1.2 Predictive forecast / time-to-threshold
Gate: `_is_forecast_question` — trigger phrase plus a parseable numeric threshold.

- "When will tube health hit 70?"
- "How long until drum level drops below 280?"
- "Time to reach 13.5 bar?"
- "Is pressure on track to trip?"
- "Will flue gas temp exceed 240 today?"

Least-squares slope over the recent window projects an ETA. Returns nothing if the metric is not trending toward the threshold.

### 1.3 Alarm and event history
Gate: `_is_alarm_history_question` — an alarm word (`alarm/alert/event/trip/fault/excursion`) **and** a time or listing cue.

- "What alarms fired in the last hour?"
- "How many critical alerts today?"
- "List the trips from yesterday."
- "Were there any faults overnight?"
- "Show me the event history for this shift."

### 1.4 Efficiency-loss attribution
Gate: `_is_efficiency_loss_question` — a loss phrase, or (efficiency context + loss cue). Explicitly declines historical windows.

- "Where am I losing efficiency?"
- "Break down my heat losses."
- "What is the biggest efficiency loss right now?"
- "How much is excess air costing me?"
- "Stack loss breakdown."

Returns a ranked split of loss components with the dominant lever and effective heat rate.

### 1.5 Consumption / totalizers
Gate: `_is_consumption_question` — a consumption verb (`how much / total / burned / consumed / produced`) plus a flow tag.

- "How much fuel did I burn this shift?"
- "Total steam produced today."
- "Feedwater consumed since midnight."
- "Show me the totalizers."

Integrates flow rate over the window. Defaults to the **current shift** when no window is named.

### 1.6 Current sensor value (VALUE route)
Gate: a named sensor tag, then an LLM intent router classifies `VALUE | HISTORY | REASON`. Only `VALUE` is served deterministically.

- "What is the drum level?"
- "Current steam pressure."
- "Is the O2 OK right now?"
- "Show me tube health."

Returns value, baseline delta, percentage deviation, and threshold status. `REASON` and `HISTORY` fall through to later handlers.

### 1.7 OEE and its factors
Gate: `is_oee_question` — an OEE term **and** a calculation term.

- "What is the current OEE?"
- "How do I calculate availability?"
- "Explain the quality factor."
- "Show the OEE calculation step by step."
- "How much good steam vs bad steam this shift?"

### 1.8 Control-loop architecture (conceptual)
Gate: `_is_control_relationship_question` — a relationship word plus a loop/process word.

- "What is the relationship between O2 and air flow?"
- "How does the pressure PID control fuel flow?"
- "Explain how drum level and feedwater are connected."

Returns a canned, correct explanation of PV / setpoint / manipulated output. Deliberately does **not** diagnose live stability.

### 1.9 Historical metrics
Gate: `answer_historical_metric_question` — a named tag plus a time expression.

- "Average O2 yesterday."
- "Highest flue gas temp this week."
- "Efficiency for 4th July."
- "Drum level between 11am and 5pm."
- "Minimum pressure last shift."

Answers the metric and its baseline comparison **only** — by design it does not explain causes.

### 1.10 Maintenance priorities
Gate: `answer_maintenance_priority_question`. Returns a structured priority card.

- "What maintenance should I prioritise?"
- "What needs attention first?"

---

## 2. Tier B — Generative path (LLM)

Everything that survives the gates above, passes the domain guardrail, and is on-topic. The prompt is assembled from: learned corrections, a deterministic physics brief, control-loop verdicts, the safety policy layer, historian context, routed manual sections, and session incident history.

### 2.1 Root-cause / diagnosis (REASON route)
- "Why is efficiency down?"
- "What is driving the drum level low?"
- "Is that a problem, and what do I do?"
- "Explain the flue gas temperature rise."

### 2.2 Live control-loop stability
- "Is the O2 control loop stable?"
- "Is the pressure controller hunting?"
- "Is the air damper responding to the O2 PID?"
- "Do I have integral windup on the drum level loop?"

Backed by a deterministic actuator-response verdict (correlation of PV error against actuator output) that the LLM must anchor to. Covers **three loops only**: pressure→fuel, O2→air, drum level→feedwater.

### 2.3 What-if simulation
Gate: `type == "what_if"` **or** the literal string `what if` in the first 40 characters.

- "What if I reduce fuel flow by 10%?"
- "What if the feedwater pump trips?"

### 2.4 Recommendations and procedures
- "What should I do about the low O2?"
- "Recommended actions for tube fouling."
- "How do I bring pressure back to setpoint?"

Filtered by the safety policy layer, which blocks disallowed action classes and flags contradictory telemetry.

### 2.5 Lightweight concepts
Gate: `_is_lightweight_concept_question` — a definition cue with no live-state cue. Skips all context injection for speed.

- "What is heat rate?"
- "Define excess air."
- "Difference between availability and performance."

### 2.6 Rejected: off-domain
Blocked by an LLM classifier that **fails open** (ambiguous replies are treated as on-domain).

- "What's the weather?" / "Write me Python." / "Ignore your instructions."

---

## 3. Where it lacks — known gaps

Ordered by how likely a client is to hit them in a live demo.

### 3.1 Root cause over a historical window — the biggest gap
"**Why** did efficiency drop **yesterday**?"

The efficiency-loss handler explicitly declines anything with `yesterday / last shift / ago`. The historical-metric handler catches it instead and, per the system prompt, returns the metric *without explaining causes*. The operator asked "why" and receives "what". **Live diagnosis and historical diagnosis are not the same feature — only live is built.**

### 3.2 Uploaded documents are never used in answers
The frontend uploads PDFs to the RAG server and they are embedded into Qdrant, but `rag_retrieve()` in `ai_analyst.py` is commented out and replaced by `route_manual()`, a keyword router over hardcoded manual sections. **A client who uploads their own boiler manual will see zero effect on answers.** Do not demo document upload as a working capability.

### 3.3 Multi-sensor questions return one sensor — FIXED
Previously `_find_requested_tag` returned the **first** matching tag in dictionary order, so "What are the pressure and drum level?" answered about pressure alone. `_find_requested_tags` now returns every sensor named, in the order asked, and the value handler emits a block per sensor.

The same fix corrected a silent mis-match: because `steam_temperature` carries the bare alias `temp`, "what is the feedwater temp" used to answer about **steam** temperature. Tags are now matched on their longest hitting alias, and a tag whose match is contained inside another's is dropped.

### 3.3b Operator feedback could not correct a deterministic answer — FIXED
Learned corrections are injected via `learning.prompt_block()` into the **Tier B prompt only**, and every Tier A handler returns before the LLM is reached. Feedback on a `VALUE` answer was stored, escalated, and never read.

Rather than teach the deterministic handler to interpret a natural-language rule (which would forfeit the determinism that makes it trustworthy), a stored correction now **demotes the route**. `LearningMemory.route_overridden(question, route)` is checked before the fast path runs; if the operator has corrected a `VALUE` answer on this topic, the question falls through to Tier B, where the correction is already in the prompt.

- Corrections are keyed on **topic**, not the exact question, so they generalise to rephrasings.
- Feedback is attributed to its handler by matching the answer text (`_lookup_answer_route`), so no frontend change was needed.
- The demotion also covers the keyword fallback, or a router outage would silently reinstate the corrected answer.
- Legacy rows migrate with `route = NULL` and therefore never demote anything.

**Tradeoff to state plainly:** a demoted question gets a slower, less predictable LLM answer — but one that respects the correction. Tier A stays authoritative by default; feedback is the escape hatch.

**Known limit:** the answer→route map is in-memory (`deque(maxlen=40)`). Feedback submitted after an engine restart is attributed to `LLM` and will not demote anything. Re-submit the feedback in the same session as the answer.

### 3.3c Terms with no sensor are named, not dropped — FIXED
Asking "pressure and NOx" used to return a confident pressure-only answer. A curated `UNSUPPORTED_TERMS` vocabulary (NOx, blowdown, conductivity, vibration, economizer, steam quality, and others) is now acknowledged explicitly:

> You also asked about **NOx**, **blowdown**. BOILER-01 has no sensor for that, so I cannot report it.

Curated rather than inferred, so there are no false positives — word-boundary matching keeps `load` out of `download`.

### 3.4 Follow-up questions break on deterministic paths
Conversation history is injected only into the Tier B prompt. Every Tier A handler receives the raw question string alone. So after "What is the drum level?":

- "And yesterday?" → no tag found, no context, falls through to a generic answer.
- "Why?" → no tag, no memory of the subject.

Follow-ups only resolve when the question re-names its subject.

### 3.5 Conditional phrasing misses the what-if simulator
The gate requires the literal `what if` within the first 40 characters.

- "What if I cut fuel by 10%?" → simulator (correct).
- "If I cut fuel by 10%, what happens?" → generic LLM answer, no simulation.
- "Suppose the pump trips." → generic LLM answer.

### 3.6 Bare keywords miss their handler
Gates require two cues, so a one-word question falls through to the LLM.

- "OEE?" → needs an OEE term **and** a calculation term. Misses.
- "Alarms?" → needs an alarm word **and** a time cue. Misses.

### 3.7 No cross-window comparison
"Compare this shift to last shift." / "Is efficiency worse than last week?"
The historian answers one window at a time. Two-window differencing is not implemented.

### 3.8 Single asset, single boiler
Every MQTT topic is hardcoded to `pumphouse4/boiler/unit01`. Any question comparing units or naming another asset has nowhere to go.

### 3.9 No financial quantification
"What is this costing me per hour?" / "Annual savings if I fix the fouling?"
Losses are reported in percent and kJ/kg. **There is no fuel price, currency, or cost model anywhere in the engine.**

### 3.10 Chat is read-only
The autopilot can write setpoints, but the chat path has no actuation. "Set the O2 setpoint to 3.0" produces advice, never a command.

### 3.11 Answer-length ceiling
The system prompt caps answers at 180 words with no tables and no headers. Broad questions ("give me a full plant health review") get truncated or shallow answers. A truncation-recovery pass exists, but it extends by 1–2 sentences only.

### 3.12 Guardrail fails open
The domain classifier only blocks on a clear `NO`. If the local model is slow, garbled, or unreachable, off-topic questions pass through to the boiler prompt (a keyword jailbreak check is the only fallback).

---

## 4. Demo guidance

**Lead with these** — deterministic, fast, visibly correct:
current value with baseline delta (single or multi-sensor); efficiency-loss breakdown; consumption totalizers; alarm history; time-to-threshold forecast; shift report; live control-loop stability verdict.

**Handle with care** — correct but generative, so phrasing-sensitive:
root-cause "why" questions on live state; recommendations; what-if.

**Avoid unless asked** — known to disappoint:
document upload; historical "why"; follow-ups without a restated subject; cost questions; cross-shift comparison; feedback submitted after an engine restart.
