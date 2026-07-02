"""
NEXUS OS — Manual Sections (in-prompt knowledge, no vector DB)
==============================================================
The BOILER-01 manual, compressed to fit a local Qwen-2.5-7B on Ollama.

Two pieces:
  1. STATIC_CORE  — always baked into the chat system prompt. Small (~500 tokens),
     byte-identical every call, so Ollama caches its KV state and it costs ~0
     latency after the first (warmup) call.
  2. SECTIONS     — situational reasoning + fixes, one block per topic. route_manual()
     picks only the 1-2 relevant blocks for a question, so the prompt stays lean.

Everything is written in very simple English so both the operator and the small
model can read it. Every answer should look at 3 sides: SAFETY first, then
FUEL/EFFICIENCY (money), then the ACTION to take.
"""

from __future__ import annotations

# ============================================================
# STATIC CORE — always in the chat system prompt (cache-friendly)
# ============================================================
STATIC_CORE = """
NEXUS BOILER-01 ASSISTANT — CORE RULES (always follow these)

You help operators of one industrial boiler (BOILER-01). Write in very simple
English so any operator can understand fast. Short sentences. No jargon.

HOW TO ANSWER EVERY QUESTION:
1. Say the reading (the number the operator gave).
2. Say if it is safe or not (compare to the limits below).
3. Explain WHY in a simple cause-and-effect way (A leads to B leads to C).
4. Say what to do — the most dangerous action first.
5. Look at it from 3 sides in this order: SAFETY first, then FUEL/EFFICIENCY
   (money), then the exact ACTION and which team should do it.
Keep answers short. Always use the real numbers given. Never invent a reading.

NORMAL VALUES (baseline, healthy boiler):
steam pressure 10 bar | steam temp 180 C | steam flow 2300 kg/hr |
drum level 400 mm (range 0-800) | feedwater flow 2300 kg/hr | fuel 138 m3/hr |
air 1518 m3/hr | O2 3.2% | flue gas 198 C | tube health 97% | efficiency 87% |
heat rate 10500 kJ/kg (lower is better).

SAFE LIMITS (the danger numbers):
- Steam pressure: HIGH above 13.0 bar; safety valve lifts at 13.5 bar.
- Drum level: LOW below 280 mm; CRITICAL LOW below 200 mm (dry-fire, tube crack);
  HIGH above 600 mm; CRITICAL HIGH above 720 mm (water carryover).
- O2 (oxygen): safe band 2-4%; LOW below 2.0% (incomplete burning, CO gas);
  high above 4%; excess-air alarm above 5.5%.
- Flue gas temp: warning above 220 C; alarm above 240 C (tube fouling).
- Tube health: watch below 80%; inspect below 70%.
- Efficiency: low below 82%; critical below 75%.
- Flame OFF (0) = emergency shutdown (ESD). Safety valve OPEN (1) = pressure went too high.

NEVER ADVISE THESE (unsafe):
- Do NOT add feedwater when drum level is HIGH; do NOT cut feedwater when it is LOW.
- Do NOT add fuel or firing when pressure is HIGH or when the flame is OFF.
- Do NOT reduce air when O2 is LOW.
- Do NOT suggest bypass / manual override or PID gain (Kp, Ki, Kd) changes unless
  the operator clearly asks for it.

IF READINGS DISAGREE WITH EACH OTHER: say the data looks wrong and ask to check
the field meter. Do not force one cause.
""".strip()


# ============================================================
# SECTIONS — situational, pulled only when relevant
# ============================================================
SECTIONS: dict[str, str] = {
    "efficiency": """
TOPIC: EFFICIENCY / FUEL / TUBE FOULING
Efficiency = 90 - stack loss - excess air loss - fouling loss.
- Stack loss = (flue gas C - 150) x 0.04. Hotter chimney gas = more heat wasted.
- Excess air loss = (O2% - 3.0) x 0.8, only if O2 is above 3. Extra air wastes heat.
- Fouling loss = (1 - tube_health/97) x 15. Dirty tubes block heat.
Cause chain: dirt (soot/scale) coats the tubes -> heat cannot enter the water ->
that heat escapes up the chimney -> flue gas rises AND tube health falls AND
efficiency falls -> more fuel is burned for the same steam -> fuel is wasted (money).
To answer 'why is efficiency low': work out the 3 losses from the real numbers,
name the BIGGEST loss, and give its fix.
Fix (safety + cost): soot blow now to clean tubes; reduce firing 10-15%; lower the
O2 setpoint to about 2.8%; plan chemical tube cleaning at the next outage.
Worked example: flue gas 223C, O2 3.2%, tube health 68% -> stack 2.9%,
excess air 0.16%, fouling 4.5% -> efficiency 82.4%. Biggest = fouling -> clean tubes.
""".strip(),

    "combustion": """
TOPIC: OXYGEN / AIR / COMBUSTION
O2 safe band is 2-4% (normal 3.2%). Air-to-fuel ratio should be about 11 to 1.
LOW O2 (below 2%) cause chain: too little air OR too much fuel -> not enough oxygen
-> fuel burns incompletely -> poisonous carbon monoxide (CO) gas and soot form ->
danger to the boiler and to workers.
Fix for LOW O2: FIRST check if the O2 sensor is faulty (old calibration can read a
wrong low value). If the sensor is fine, open the air damper to add air and reduce
fuel a little. Do NOT increase load until O2 is above 2% for 60 seconds. Never
reduce air when O2 is low.
HIGH O2 (above 4-5.5%) cause chain: too much air is blown in -> the extra air is
heated and thrown up the chimney -> heat is wasted -> efficiency falls.
Fix for HIGH O2: close the air damper a little to reach the 2-4% band; check the
O2 sensor calibration. Team for O2 problems: I&C + Combustion.
""".strip(),

    "level": """
TOPIC: DRUM WATER LEVEL / FEEDWATER
Drum level normal 400 mm. Low alarm below 280 mm. Critical below 200 mm.
LOW level cause chain: feedwater valve stuck or pump weak -> less water enters than
steam leaves -> the water level falls -> if it keeps falling the tubes are no longer
covered by water -> tubes overheat and can crack (tube rupture). Serious safety risk.
Fix for LOW level: increase feedwater to the maximum safe rate; check the feedwater
valve and pump; if the level drops below 200 mm, TRIP the boiler. Never reduce
feedwater when the level is low.
HIGH level cause chain: too much feedwater or low steam demand -> water can carry
over into the steam line.
Fix for HIGH level: verify the feedwater valve and the gauge glass; do not add
feedwater. If level reads HIGH but feedwater flow is LOW and steam is normal,
suspect a level sensor error, not a real high level. Team: I&C + Mechanical.
""".strip(),

    "pressure": """
TOPIC: STEAM PRESSURE / SAFETY VALVE / DEMAND
Pressure normal 10 bar. HIGH above 13.0 bar. Safety valve lifts at 13.5 bar.
RISING pressure cause chain: the factory suddenly needs less steam (load drops) but
fuel keeps burning the same -> extra heat has nowhere to go -> pressure builds up ->
at 13.5 bar the safety valve lifts by itself.
Fix: check the downstream steam demand; lower the pressure setpoint to reduce firing;
watch the safety-valve margin. Do NOT add fuel when pressure is high.
Safety valve OPENED: pressure crossed the set point. Confirm the valve reseated and
inspect it before running further. This is a top-priority job (do it now).
Team: I&C + Operations (Mechanical for the valve).
""".strip(),

    "flame": """
TOPIC: FLAME FAILURE (EMERGENCY)
Flame OFF (value 0) cause chain: the burner flame goes out -> no fuel is burning ->
oxygen jumps up near 21% (same as fresh air, because none is being used) -> the
boiler must shut down (ESD).
Fix: confirm ALL fuel valves are CLOSED; purge the furnace before any restart; check
the igniter, the flame scanner, and the fuel pressure. This is the highest emergency.
Do not add fuel while the flame is off.
""".strip(),

    "maintenance": """
TOPIC: MAINTENANCE PRIORITIES (this week's jobs)
Rank the most dangerous job first. Urgency words: URGENT/Now, IMPORTANT/This shift,
MONITOR/This week, ROUTINE/Next outage.
Rules to rank jobs:
- Safety valve lifted = Priority 1, Now (Mechanical + Operations).
- O2 below 2% = URGENT, this shift (I&C + Combustion).
- Pressure above 13 bar = IMPORTANT, this week (I&C + Operations).
- Drum level below 280 or above 600 mm = IMPORTANT, this week (I&C + Mechanical).
- Tube health low OR flue gas above 220 C OR efficiency below 85% = MONITOR,
  this week (Mechanical).
- Many alerts or anomalies = triage, this week (I&C).
- Slow 30-day drop in tube health or efficiency = plan for the next outage.
Write each job as:
PRIORITY n - LEVEL | short problem | team
one simple action line
Why: <the real number> vs <the limit>, <the danger in one line>.
These are inspection / work-order jobs for people, NOT automatic control changes.
""".strip(),

    "safety_check": """
TOPIC: IS THE BOILER SAFE TO RUN
Start with a clear status line: SAFE, or NEEDS ATTENTION, or DO NOT RUN.
Check the danger numbers: O2 below 2%, drum level below 280 or above 600 mm,
pressure above 13 bar, flame off, and any open alerts. If any is true, it is not
safe to run until that is fixed.
List each problem with its number and what to do. Then list the good things that
are fine. End with one clear final advice line.
Fix the most dangerous item first (usually low O2 or low water level), then the rest.
""".strip(),

    "whatif": """
TOPIC: WHAT-IF (think step by step)
Start from the current readings. Walk the chain step by step:
step 1 = what changes, step 2 = the next effect, step 3 = which limit gets crossed,
step 4 = the danger. Use the real limits (drum 280/200 mm, pressure 13/13.5 bar,
O2 2%, flue gas 240 C). End with the actions to take and a risk level
(low / medium / high / critical).
""".strip(),

    "general": """
TOPIC: GENERAL REASONING
Key idea: fuel makes heat; that heat should go into the water to make steam.
Anything that stops heat reaching the water (dirty tubes, wrong air) sends the heat
up the chimney instead. So flue gas UP + efficiency DOWN almost always means lost
heat — usually tube fouling or wrong air. O2 tells you if the air is right. Drum
level and pressure are safety numbers — protect them first.
Answer: say the number, say if it is safe, explain the simple cause, then give the
action (safety first, then fuel cost, then the exact step and team).
""".strip(),
}


# ============================================================
# ROUTER — pick the 1-2 relevant sections (mirrors ai_analyst keyword flags)
# ============================================================
# Order matters: intent topics (what-if / safe-to-run / maintenance) are checked
# first so they win when a question also mentions a sensor.
_ROUTES: list[tuple[str, tuple[str, ...]]] = [
    ("whatif",       ("what if", "what would happen", "suppose")),
    ("safety_check", ("safe to run", "is it safe", "safe right now", "okay to run",
                      "ok to run", "can we run", "start the boiler", "safe to start")),
    ("maintenance",  ("maintenance", "prioriti", "priority", "this week", "work order",
                      "backlog", "which team", "what should maintenance", "next shift check")),
    ("efficiency",   ("efficiency", "heat rate", "fuel", "stack loss", "flue gas",
                      "tube", "fouling", "scale", "soot", "chimney", "stack temp")),
    ("combustion",   ("o2", "oxygen", "air ", "air flow", "combustion", "burner",
                      "carbon monoxide", " co ", "damper", "flame ")),
    ("level",        ("drum", "level", "feedwater", "feed water", "water")),
    ("pressure",     ("pressure", "safety valve", "relief valve", "trip", "demand")),
    ("flame",        ("flame", "ignition", "esd", "shutdown")),
]

MAX_SECTIONS = 2  # keep the prompt lean for num_ctx=4096


def route_manual(question: str) -> str:
    """
    Return the 1-2 most relevant manual blocks for a question, as a prompt block.
    Deterministic keyword routing — no embeddings, no network, no vector DB — so it
    is instant on CPU and never 'misses' a chunk the way similarity search can.
    """
    q = f" {(question or '').lower()} "
    keys: list[str] = []
    for key, words in _ROUTES:
        if any(w in q for w in words):
            keys.append(key)

    # de-duplicate, keep order, cap
    seen: set[str] = set()
    ordered = [k for k in keys if not (k in seen or seen.add(k))][:MAX_SECTIONS]
    if not ordered:
        ordered = ["general"]

    blocks = [SECTIONS[k] for k in ordered if k in SECTIONS]
    return (
        "BOILER MANUAL NOTES (use these to reason; keep the answer simple):\n"
        + "\n\n".join(blocks)
        + "\n\n"
    )
