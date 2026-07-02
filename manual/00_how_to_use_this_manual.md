# NEXUS OS Boiler Manual — How To Use This Book

This manual teaches the BOILER-01 rules to the AI helper (chatbot). It is written
in very simple English so both plant operators and a small local AI model can read
it and think clearly.

## What is inside this manual
- Book 01: Normal values. What each meter should read when the boiler is healthy.
- Book 02: Safety limits. The danger numbers and what each alarm means.
- Book 03: The maths. Easy formulas that link one meter to another.
- Book 04: Cause and effect chains. If A changes, then B and C change. This is how to reason.
- Book 05: Efficiency explained. Why fuel is wasted, with worked sums.
- Book 06: Maintenance priority rules. How to rank this week's repair jobs.
- Book 07: How to answer. The answer style plus ready examples to copy.
- Book 08: Question bank. The common operator questions.

## How the AI should use this manual
1. Read the sensor numbers the operator gives you (like O2 = 0.47 %).
2. Find the matching rule in Book 02 (is this number safe or dangerous?).
3. Follow the cause and effect chain in Book 04 to explain WHY.
4. Use the maths in Book 03 and Book 05 only if the operator asks "how much" or "why".
5. Copy the answer shape from Book 07. Keep the language very simple.

## Golden rules for the AI
- Always use the real numbers the operator gives. Never invent a reading.
- Say the number, then say if it is safe or not, then say what to do.
- Give the most dangerous problem first (Priority 1), then the next.
- Use short sentences and common words. An operator on the floor must understand fast.
- If two readings do not agree with each other, say the data looks wrong and ask to check the meter. Do not force one answer.
- Never tell the operator to do a dangerous action (see Book 02 blocked actions).

## Units used in this manual
- bar = pressure. Higher bar = more pressure.
- °C = temperature in Celsius.
- kg/hr = kilograms per hour (mass of water or steam moving).
- m³/hr = cubic metres per hour (volume of gas or air).
- % = percent.
- mm = millimetre (used for the water level height in the drum).
- kJ/kg = kilojoules per kilogram (energy used to make each kg of steam).

## How to make the PDF
Each Book is one Markdown (.md) file. Open it in any Markdown-to-PDF tool
(for example VS Code "Markdown PDF", or `pandoc file.md -o file.pdf`) and export.
Keep each Book as its own short PDF, or join them. The RAG reader will read the text.
