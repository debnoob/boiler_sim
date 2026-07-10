# Boiler AI Answer Simplification Plan

## Goal

Make all boiler AI answers easier for plant operators to understand, especially Indian control-room operators.

The main rule is:

> Simple operator language should be global. Strict JSON should be used only where the dashboard needs structured fields.

## 1. Global Language Rule

Every operator-visible answer must use simple control-room English.

Apply this to:

- Tier A deterministic answers
- Tier B LLM answers
- Incident cards
- Shift reports
- Maintenance priorities
- What-if simulations
- Fallback/error answers

Use this style:

```text
Use short sentences.
Start with the direct answer.
Use real readings and limits.
Say if it is SAFE, WATCH, or URGENT.
Say what is happening.
Say what the operator should do next.
Avoid theory unless the operator asks for it.
```

Avoid words like:

```text
pinned
deviated
dynamically responding
cap
excursion
attribution
steam demand reduction state
deterministic hypothesis
```

Use simpler words instead:

```text
at max limit
different from normal
changing
limit
alarm event
main reason
steam demand is reducing
likely cause
```

## 2. JSON Policy

Do not use strict JSON for every chat answer.

Use this rule:

```text
Operator-visible language = always simple.
Strict JSON = only for cards, reports, simulations, and UI workflows.
Plain text = normal Ask the Plant chat answers.
```

Strict JSON is useful when the frontend needs fields like:

- status
- headline
- severity
- probable cause
- evidence
- recommended actions
- watch items

Plain text is better for normal chat because operators should not read raw JSON.

## 3. Question Routing Plan

The current question bank in `AI_CHAT_ANSWERABLE_QUESTIONS.md` already has two answer tiers:

- Tier A: deterministic answers from telemetry, historian SQL, or physics
- Tier B: LLM answers grounded in telemetry, safety policy, and manual context

### Tier A: Plain Easy Language

Use plain easy language for these question types:

- Current sensor values
- Efficiency-loss breakdown
- Consumption and totalizers
- Alarm and event history
- Forecast / time-to-threshold
- Historical metrics
- OEE calculations
- Control-loop architecture explanations
- Lightweight concepts

These answers are computed locally. They do not need strict JSON unless the UI renders them as a special card.

### Tier B: Plain Easy Language

Use LLM-generated plain easy language for these question types:

- Root cause and diagnosis questions
- Live control-loop stability questions
- Recommendation and procedure questions
- Normal Ask the Plant follow-up questions

Examples:

```text
Why is efficiency down?
What is driving the drum level low?
Is this a problem?
What should I do?
Is the pressure controller hunting?
How do I bring pressure back to setpoint?
```

### Structured JSON Routes

Use strict JSON plus easy language inside every field for:

- AI incident cards
- Critical/high alert diagnosis
- Shift reports
- Maintenance priority cards
- What-if simulation cards
- Control/action event cards

The dashboard should render these fields as UI cards. It should not show raw JSON to the operator.

## 4. Shared Operator Language Contract

Add one reusable language contract in `engine/ai_analyst.py`.

Example:

```python
OPERATOR_LANGUAGE_RULES = """
Write for Indian boiler plant operators.
Use simple English and short sentences.
Start with the direct answer.
Use real readings and limits.
Say SAFE / WATCH / URGENT where useful.
Do not use complex words like pinned, cap, excursion, attribution, dynamically responding.
Do not explain theory unless the operator asks for it.
Keep normal chat answers under 120 words.
Use dash bullets for actions.
"""
```

Inject this into:

- `CHAT_SYSTEM_PROMPT`
- incident diagnosis prompt
- alert diagnosis prompt
- what-if prompt
- shift report prompt
- deterministic fallback diagnosis text

## 5. Incident Card Schema

Keep strict JSON for incident cards, but make the fields operator-friendly.

Recommended schema:

```json
{
  "status": "WATCH",
  "headline": "Fuel flow is normal. Pressure is rising.",
  "probable_cause": "Steam demand is reducing",
  "severity": "warning",
  "simple_explanation": "Fuel and air are both reducing, so firing is coming down. Pressure is still rising because steam use has reduced.",
  "operator_actions": [
    "Check downstream steam header flow.",
    "Watch pressure closely.",
    "No fuel-limit action needed now."
  ],
  "watch_items": [
    "Pressure: 12.11 bar. Alert at 13.0 bar. Safety valve at 13.5 bar."
  ],
  "evidence": [
    "Fuel flow 151.35 m3/hr, below max limit.",
    "Air flow is falling.",
    "Safety valve is closed."
  ],
  "confidence": 85
}
```

Keep existing fields if the frontend already depends on them, but add these simpler fields for display.

## 6. Normal Chat Answer Shape

For diagnosis or "why" questions, use this format:

```text
STATUS: <direct answer>

WHAT IS HAPPENING:
<2 short lines with numbers>

RISK:
<one line>

ACTION:
- <step 1>
- <step 2>
- <step 3>
```

For simple sensor questions, use this format:

```text
Steam pressure is 12.11 bar now.
Normal value is 10.0 bar.
Status: Watch. Alert starts at 13.0 bar.
```

## 7. Example Rewrite

Current confusing answer:

```text
Fuel flow is NOT pinned. The current reading is 151.35 m3/hr...
```

Operator-friendly answer:

```text
STATUS: Fuel flow is not at max limit.

Fuel flow is 151.35 m3/hr. Normal is 138.0 m3/hr. This is only 9.7% higher than normal and far below the full-load limit.

WHAT IS HAPPENING:
Fuel flow and air flow are both reducing. This means firing rate is coming down.
But steam pressure is still rising, so steam demand may have reduced.

PRESSURE:
Pressure is 12.11 bar now.
Alert starts at 13.0 bar.
Safety valve opens at 13.5 bar.
Safety valve is closed now.

ACTION:
- Check downstream steam header flow.
- Keep watching pressure.
- No fuel-limit action is needed now.
```

## 8. Implementation Order

1. Add `OPERATOR_LANGUAGE_RULES` in `engine/ai_analyst.py`.
2. Inject the rules into all LLM prompts.
3. Update deterministic answer renderers to use simpler phrases.
4. Keep strict JSON for incident, alert, shift, maintenance, and what-if cards.
5. Add simple frontend rendering labels: Status, Reason, Action, Watch.
6. Add golden tests for the question bank.
7. Run the fuel-flow/pressure scenario and tune wording.

## 9. Test Checklist

Create golden tests for representative questions.

Minimum test questions:

```text
What are the fuel flow and air flow right now?
Time to reach 13.5 bar?
Why is efficiency down?
What should I do about low O2?
What if I reduce fuel flow by 10%?
Give me the shift report.
What maintenance should I prioritise?
```

Each answer should pass these checks:

- No banned jargon
- First line gives direct status
- Real numbers are preserved
- Action is clear
- JSON parses for card routes
- Raw JSON is not shown in chat
- Normal chat answer is under 120 words where possible

## Final Decision

Use easy language everywhere.

Use strict JSON only for structured dashboard outputs:

- incident cards
- alert cards
- shift reports
- maintenance cards
- what-if cards
- control/action cards

Normal chat should sound like a shift engineer speaking clearly, not like a technical report.
