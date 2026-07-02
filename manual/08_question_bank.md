# Book 08 — Question Bank (Common Operator Questions)

These are the questions the AI should be ready to answer for BOILER-01.
For each, the AI reads the live numbers, finds the rule (Book 02), follows the
chain (Book 04), and answers in the simple style (Book 07).

## Maintenance and priority questions
- What should maintenance do this week?
- What jobs should we prioritise?
- What is the most urgent repair right now?
- What should the next shift check?
- Which team should handle this problem?

## Safety questions
- Is the boiler safe to run right now?
- Is it safe to increase load?
- Should we trip the boiler?
- Is the drum water level safe?
- Is the steam pressure safe?

## Oxygen and combustion questions
- Oxygen is showing 0.3 percent. What to do?
- Why is the oxygen so low?
- Why is oxygen high?
- Is the air-fuel mixture correct?
- Is there a carbon monoxide risk?

## Efficiency and fuel questions
- Why has efficiency dropped?
- Why are we using more fuel?
- What is the biggest heat loss right now?
- Is the heat rate normal?
- How can we save fuel?

## Tube and heat-transfer questions
- Why is the flue gas temperature rising?
- Is there tube fouling?
- When should we clean the tubes?
- Is tube health falling?

## Pressure and steam questions
- Why is steam pressure rising?
- Will the safety valve lift?
- Why did the safety valve open?
- Is steam demand normal?

## Water level and feedwater questions
- Why is the drum level falling?
- Why is the drum level high?
- Is the feedwater flow enough?
- Is the feedwater valve working?

## Trend and history questions
- What was the lowest oxygen this week?
- What was the highest pressure yesterday?
- How many alerts came this week?
- Compare efficiency this shift to last shift.
- Is tube health worse than last month?

## What-if questions (think step by step)
- What if the feedwater pump stops?
- What if we increase firing now?
- What if the air damper sticks closed?
- What if steam demand drops suddenly?
- What if we ignore the low oxygen?

## Rules for the AI when answering any question
- If the question asks only for a current value, just give the value and compare to baseline. Do not add causes.
- If the question asks "why", explain the cause chain with real numbers.
- If the question asks "what to do" or "recommend", give ordered actions, safest first.
- If the question is about the past (yesterday, week, month), use the stored history numbers and state the time range.
- If the question is not about the boiler, politely refuse and ask for a boiler question.
