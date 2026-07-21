"""
NEXUS OS - Local historian query layer.

SQLite is the default local historian so the demo works without Docker. The
public functions return compact summaries for the LLM instead of raw long-range
telemetry dumps.
"""

from __future__ import annotations

import json
import math
import os
import re
import sqlite3
import statistics
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB_PATH = str(PROJECT_ROOT / "historian" / "nexus_historian.db")
HISTORIAN_DB_PATH = os.environ.get("HISTORIAN_DB_PATH", DEFAULT_DB_PATH)
RETENTION_DAYS = int(os.environ.get("HISTORIAN_RETENTION_DAYS", "92"))

# Storing the full heartbeat payload as JSON on every row is ~55% of each row's
# bytes and is never read back (queries use the typed columns; only
# historian_events.payload_json is parsed). Off by default to roughly halve the
# telemetry_raw footprint. Set HISTORIAN_STORE_RAW_PAYLOAD=true to retain it.
STORE_RAW_PAYLOAD = os.environ.get(
    "HISTORIAN_STORE_RAW_PAYLOAD", "false"
).strip().lower() in ("1", "true", "yes", "on")

NUMERIC_TAGS = [
    "steam_pressure",
    "steam_temperature",
    "steam_flow",
    "drum_level",
    "feedwater_flow",
    "feedwater_temp",
    "feedwater_ph",
    "dissolved_oxygen",
    "fuel_flow",
    "air_flow",
    "o2_percent",
    "flue_gas_temp",
    "furnace_pressure_pa",
    "stack_draft_pa",
    "flue_gas_flow_kg_hr",
    "stack_damper_command_pct",
    "stack_damper_actual_pct",
    "stack_exit_temp_c",
    "chimney_skin_temp_c",
    "flame_status",
    "safety_valve",
    "tube_health",
    "tube_wall_thickness",
    "corrosion_rate",
    "tube_leak_flow",
    "efficiency",
    "heat_rate",
]

TAG_ALIASES = {
    "steam_pressure": ("steam pressure", "pressure", "boiler pressure"),
    "steam_temperature": ("steam temperature", "steam temp", "temperature"),
    "steam_flow": ("steam flow", "steam output", "steam production"),
    "drum_level": ("drum level", "water level", "level"),
    "feedwater_flow": ("feedwater flow", "feed water flow"),
    "feedwater_temp": ("feedwater temperature", "feedwater temp"),
    "feedwater_ph": ("feedwater ph", "water ph", "ph"),
    "dissolved_oxygen": ("dissolved oxygen", "do ppb", "oxygen in feedwater"),
    "fuel_flow": ("fuel flow", "gas flow", "fuel"),
    "air_flow": ("air flow", "combustion air"),
    "o2_percent": ("o2", "oxygen", "oxygen percent", "o2 percent"),
    "flue_gas_temp": ("flue gas", "flue gas temperature", "stack temp", "stack temperature"),
    "furnace_pressure_pa": ("furnace pressure", "furnace draft", "draft pressure"),
    "stack_draft_pa": ("stack draft", "chimney draft"),
    "flue_gas_flow_kg_hr": ("flue gas flow", "stack flow"),
    "stack_damper_command_pct": ("stack damper command", "damper command"),
    "stack_damper_actual_pct": ("stack damper", "damper position"),
    "stack_exit_temp_c": ("stack exit temperature", "chimney exit temperature"),
    "chimney_skin_temp_c": ("chimney skin temperature", "stack skin temperature"),
    "flame_status": ("flame", "flame status"),
    "safety_valve": ("safety valve", "relief valve"),
    "tube_health": ("tube health", "tube condition"),
    "tube_wall_thickness": ("tube wall", "wall thickness", "tube thickness"),
    "corrosion_rate": ("corrosion rate", "metal loss rate"),
    "tube_leak_flow": ("tube leak", "leak flow", "boiler leak"),
    "efficiency": ("efficiency", "boiler efficiency"),
    "heat_rate": ("heat rate", "heatrate"),
}

BASELINES = {
    "steam_pressure": 10.0,
    "steam_temperature": 180.0,
    "steam_flow": 2300.0,
    "drum_level": 400.0,
    "feedwater_flow": 2300.0,
    "feedwater_temp": 95.0,
    "feedwater_ph": 8.8,
    "dissolved_oxygen": 10.0,
    "fuel_flow": 138.0,
    "air_flow": 1518.0,
    "o2_percent": 3.2,
    "flue_gas_temp": 198.0,
    "furnace_pressure_pa": -20.0,
    "stack_draft_pa": -100.0,
    "flue_gas_flow_kg_hr": 1600.0,
    "stack_damper_command_pct": 62.0,
    "stack_damper_actual_pct": 62.0,
    "stack_exit_temp_c": 198.0,
    "chimney_skin_temp_c": 46.0,
    "tube_health": 97.0,
    "tube_wall_thickness": 6.0,
    "corrosion_rate": 0.02,
    "tube_leak_flow": 0.0,
    "efficiency": 87.0,
}

UNITS = {
    "steam_pressure": "bar",
    "steam_temperature": "C",
    "steam_flow": "kg/hr",
    "drum_level": "mm",
    "feedwater_flow": "kg/hr",
    "feedwater_temp": "C",
    "feedwater_ph": "pH",
    "dissolved_oxygen": "ppb",
    "fuel_flow": "m3/hr",
    "air_flow": "kg/hr",
    "o2_percent": "%",
    "flue_gas_temp": "C",
    "furnace_pressure_pa": "Pa",
    "stack_draft_pa": "Pa",
    "flue_gas_flow_kg_hr": "kg/hr",
    "stack_damper_command_pct": "%",
    "stack_damper_actual_pct": "%",
    "stack_exit_temp_c": "C",
    "chimney_skin_temp_c": "C",
    "tube_health": "%",
    "tube_wall_thickness": "mm",
    "corrosion_rate": "mm/year",
    "tube_leak_flow": "kg/hr",
    "efficiency": "%",
    "heat_rate": "kJ/kg",
}

NUMBER_WORDS = {
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
    "eleven": 11,
    "twelve": 12,
    "thirteen": 13,
    "fourteen": 14,
    "fifteen": 15,
    "sixteen": 16,
    "seventeen": 17,
    "eighteen": 18,
    "nineteen": 19,
    "twenty": 20,
    "thirty": 30,
    "forty": 40,
    "fifty": 50,
    "sixty": 60,
    "ninety": 90,
}


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def parse_timestamp(value: Any | None) -> datetime:
    if value is None:
        return utc_now()
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value), tz=timezone.utc)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return utc_now()
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return utc_now()
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    return utc_now()


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def local_tz():
    """This machine's local timezone (what an operator's clock shows)."""
    return datetime.now(timezone.utc).astimezone().tzinfo


def now_local(now: datetime | None = None) -> datetime:
    """Current time as a tz-aware datetime in the operator's local timezone."""
    return (now or utc_now()).astimezone(local_tz())


def default_db_path() -> str:
    return HISTORIAN_DB_PATH


def _ensure_parent(path: str) -> None:
    parent = Path(path).expanduser().resolve().parent
    parent.mkdir(parents=True, exist_ok=True)


@contextmanager
def connect(db_path: str | None = None):
    path = db_path or default_db_path()
    _ensure_parent(path)
    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def check_integrity(db_path: str | None = None) -> tuple[bool, str]:
    """Run SQLite's own integrity check before trusting an existing database file.

    A malformed SQLite file does not fail loudly on open — basic statements like
    CREATE TABLE IF NOT EXISTS raise sqlite3.DatabaseError immediately, but only
    once something tries to touch the file, and callers were only catching that
    around read queries (see the historian-question fallback below). A corrupt
    file could sit there for days before anyone noticed a symptom. This is a
    plain connection with no WAL pragma, on purpose: a file too damaged to accept
    PRAGMA journal_mode=WAL should still fail this check, not fail later.
    """
    path = db_path or default_db_path()
    if not Path(path).expanduser().exists():
        return True, "no existing database file"
    try:
        conn = sqlite3.connect(path, timeout=30)
        try:
            row = conn.execute("PRAGMA integrity_check(1)").fetchone()
            detail = row[0] if row else "no result from integrity_check"
            return detail == "ok", detail
        finally:
            conn.close()
    except sqlite3.DatabaseError as exc:
        return False, str(exc)


def quarantine_corrupt_db(db_path: str | None = None) -> str:
    """Move a corrupt database (and its WAL/SHM sidecars) aside so a fresh one
    can be created without deleting the evidence.

    The sidecars move with the main file on purpose: an earlier corruption in
    this project left a `-wal`/`-shm` pair with no main `.db` file next to it,
    because only the main file had been moved. Recovery from a quarantined file
    is still possible with `sqlite3 <file> ".recover"`.
    """
    path = Path((db_path or default_db_path())).expanduser()
    stamp = None
    try:
        stamp = int(path.stat().st_mtime)
    except OSError:
        pass
    suffix = f".corrupt.{stamp}" if stamp is not None else ".corrupt"
    quarantined = str(path) + suffix
    for sidecar_suffix in ("", "-wal", "-shm"):
        src = Path(str(path) + sidecar_suffix)
        if src.exists():
            src.rename(quarantined + sidecar_suffix)
    return quarantined


def init_db(db_path: str | None = None) -> None:
    tag_columns = ",\n            ".join(f"{tag} REAL" for tag in NUMERIC_TAGS)
    rollup_columns = ",\n                ".join(
        f"{tag}_sum REAL NOT NULL DEFAULT 0,\n"
        f"                {tag}_min REAL,\n"
        f"                {tag}_max REAL"
        for tag in NUMERIC_TAGS
    )
    with connect(db_path) as conn:
        conn.executescript(
            f"""
            CREATE TABLE IF NOT EXISTS telemetry_raw (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL,
                unit TEXT NOT NULL DEFAULT 'BOILER-01',
                mode TEXT,
                tick INTEGER,
                degradation_factor REAL,
                {tag_columns},
                control_json TEXT,
                payload_json TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_telemetry_raw_ts
                ON telemetry_raw(ts);
            CREATE INDEX IF NOT EXISTS idx_telemetry_raw_unit_ts
                ON telemetry_raw(unit, ts);
            CREATE INDEX IF NOT EXISTS idx_telemetry_raw_mode_ts
                ON telemetry_raw(mode, ts);

            CREATE TABLE IF NOT EXISTS telemetry_rollup (
                bucket_start TEXT NOT NULL,
                bucket_seconds INTEGER NOT NULL,
                unit TEXT NOT NULL DEFAULT 'BOILER-01',
                count INTEGER NOT NULL DEFAULT 0,
                {rollup_columns},
                PRIMARY KEY (bucket_start, bucket_seconds, unit)
            );

            CREATE INDEX IF NOT EXISTS idx_telemetry_rollup_bucket
                ON telemetry_rollup(bucket_seconds, bucket_start);

            CREATE TABLE IF NOT EXISTS historian_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL,
                event_type TEXT NOT NULL,
                severity TEXT,
                tag TEXT,
                score REAL,
                message TEXT,
                payload_json TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_historian_events_ts
                ON historian_events(ts);
            CREATE INDEX IF NOT EXISTS idx_historian_events_type_ts
                ON historian_events(event_type, ts);
            CREATE INDEX IF NOT EXISTS idx_historian_events_severity_ts
                ON historian_events(severity, ts);
            """
        )
        # Add newly introduced telemetry fields to existing historian databases.
        raw_columns = {row[1] for row in conn.execute("PRAGMA table_info(telemetry_raw)")}
        for tag in NUMERIC_TAGS:
            if tag not in raw_columns:
                conn.execute(f"ALTER TABLE telemetry_raw ADD COLUMN {tag} REAL")

        rollup_columns_existing = {row[1] for row in conn.execute("PRAGMA table_info(telemetry_rollup)")}
        for tag in NUMERIC_TAGS:
            for suffix, declaration in (
                ("sum", "REAL NOT NULL DEFAULT 0"),
                ("min", "REAL"),
                ("max", "REAL"),
            ):
                column = f"{tag}_{suffix}"
                if column not in rollup_columns_existing:
                    conn.execute(f"ALTER TABLE telemetry_rollup ADD COLUMN {column} {declaration}")


def prune_old_data(db_path: str | None = None, retention_days: int = RETENTION_DAYS) -> None:
    cutoff = iso(utc_now() - timedelta(days=retention_days))
    with connect(db_path) as conn:
        conn.execute("DELETE FROM telemetry_raw WHERE ts < ?", (cutoff,))
        conn.execute("DELETE FROM telemetry_rollup WHERE bucket_start < ?", (cutoff,))
        conn.execute("DELETE FROM historian_events WHERE ts < ?", (cutoff,))


def _float_or_none(value: Any) -> float | None:
    try:
        if value is None:
            return None
        numeric = float(value)
        if math.isnan(numeric) or math.isinf(numeric):
            return None
        return numeric
    except (TypeError, ValueError):
        return None


# ============================================================
# SHIFT-WINDOW QUERIES (feed the end-of-shift report for a real 8h shift)
# ============================================================
def fetch_telemetry_window(
    start: datetime, end: datetime, db_path: str | None = None
) -> list[dict[str, Any]]:
    """
    Return telemetry_raw rows in [start, end) as dicts with an epoch timestamp
    and a tag map, ordered oldest-first. Used to recompute shift OEE/uptime for
    the true shift window (survives analyst restarts). start/end are tz-aware.
    """
    init_db(db_path)
    cols = ", ".join(NUMERIC_TAGS)
    rows: list[dict[str, Any]] = []
    with connect(db_path) as conn:
        cur = conn.execute(
            f"SELECT ts, mode, {cols} FROM telemetry_raw "
            f"WHERE ts >= ? AND ts < ? ORDER BY ts ASC",
            (iso(start), iso(end)),
        )
        for r in cur:
            rows.append({
                "ts_epoch": parse_timestamp(r["ts"]).timestamp(),
                "mode": r["mode"] or "NORMAL",
                "tags": {tag: r[tag] for tag in NUMERIC_TAGS},
            })
    return rows


def telemetry_coverage(
    start: datetime, end: datetime, db_path: str | None = None
) -> dict[str, Any] | None:
    """
    Lightweight coverage probe for [start, end): how many telemetry samples exist
    and the first/last sample times (returned as tz-aware LOCAL datetimes), or
    None when the window holds no samples. Used to turn an empty shift-report into
    a helpful "data only exists for HH:MM-HH:MM" answer instead of a dead end.
    """
    init_db(db_path)
    with connect(db_path) as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n, MIN(ts) AS first_ts, MAX(ts) AS last_ts "
            "FROM telemetry_raw WHERE ts >= ? AND ts < ?",
            (iso(start), iso(end)),
        ).fetchone()
    if not row or not row["n"]:
        return None
    return {
        "count": row["n"],
        "first_local": parse_timestamp(row["first_ts"]).astimezone(local_tz()),
        "last_local": parse_timestamp(row["last_ts"]).astimezone(local_tz()),
    }


def count_events_window(
    start: datetime,
    end: datetime,
    db_path: str | None = None,
    anomaly_gap_seconds: float = 30.0,
) -> dict[str, Any]:
    """
    Alert counts by severity + a deduped anomaly-episode count in [start, end).
    Anomaly ticks stream at ~1 Hz, so consecutive is_anomaly hits within
    anomaly_gap_seconds are collapsed into one episode (mirrors the live
    per-diagnosis counting in ShiftStats).
    """
    init_db(db_path)
    alerts = {"CRITICAL": 0, "HIGH": 0, "WARNING": 0, "LOW": 0}
    anomaly_episodes = 0
    with connect(db_path) as conn:
        cur = conn.execute(
            "SELECT severity, COUNT(*) AS n FROM historian_events "
            "WHERE event_type = 'alert' AND ts >= ? AND ts < ? GROUP BY severity",
            (iso(start), iso(end)),
        )
        for r in cur:
            sev = (r["severity"] or "").upper()
            if sev in alerts:
                alerts[sev] += r["n"]

        cur = conn.execute(
            "SELECT ts, payload_json FROM historian_events "
            "WHERE event_type = 'anomaly_score' AND ts >= ? AND ts < ? ORDER BY ts ASC",
            (iso(start), iso(end)),
        )
        last_episode_t = None
        for r in cur:
            try:
                is_anom = bool(json.loads(r["payload_json"]).get("is_anomaly"))
            except (TypeError, ValueError):
                is_anom = False
            if not is_anom:
                continue
            t = parse_timestamp(r["ts"]).timestamp()
            if last_episode_t is None or (t - last_episode_t) > anomaly_gap_seconds:
                anomaly_episodes += 1
            last_episode_t = t
    return {"alerts": alerts, "anomaly_episodes": anomaly_episodes}


def insert_heartbeat(payload: dict[str, Any], db_path: str | None = None) -> None:
    init_db(db_path)
    tags = payload.get("tags", {}) if isinstance(payload.get("tags"), dict) else {}
    parsed_ts = parse_timestamp(payload.get("timestamp"))
    ts = iso(parsed_ts)
    values = {tag: _float_or_none(tags.get(tag)) for tag in NUMERIC_TAGS}
    columns = [
        "ts",
        "unit",
        "mode",
        "tick",
        "degradation_factor",
        *NUMERIC_TAGS,
        "control_json",
        "payload_json",
    ]
    row = {
        "ts": ts,
        "unit": str(payload.get("unit") or "BOILER-01"),
        "mode": payload.get("mode"),
        "tick": payload.get("tick"),
        "degradation_factor": _float_or_none(payload.get("degradation_factor")),
        **values,
        "control_json": json.dumps(payload.get("control", {}), separators=(",", ":")),
        # Full raw payload is redundant with the typed columns and never queried
        # for telemetry_raw; store "{}" unless explicitly retained (see flag above).
        "payload_json": (
            json.dumps(payload, separators=(",", ":"), default=str)
            if STORE_RAW_PAYLOAD
            else "{}"
        ),
    }
    placeholders = ",".join("?" for _ in columns)
    with connect(db_path) as conn:
        conn.execute(
            f"INSERT INTO telemetry_raw ({','.join(columns)}) VALUES ({placeholders})",
            [row.get(col) for col in columns],
        )
        _upsert_rollup(conn, parsed_ts, row["unit"], values, 60)
        _upsert_rollup(conn, parsed_ts, row["unit"], values, 3600)


def _bucket_start(dt: datetime, bucket_seconds: int) -> str:
    epoch = int(dt.timestamp())
    bucket_epoch = (epoch // bucket_seconds) * bucket_seconds
    return iso(datetime.fromtimestamp(bucket_epoch, tz=timezone.utc))


def _upsert_rollup(
    conn: sqlite3.Connection,
    ts: datetime,
    unit: str,
    values: dict[str, float | None],
    bucket_seconds: int,
) -> None:
    bucket_start = _bucket_start(ts, bucket_seconds)
    columns = ["bucket_start", "bucket_seconds", "unit", "count"]
    row_values: list[Any] = [bucket_start, bucket_seconds, unit, 1]
    updates = ["count = count + 1"]

    for tag in NUMERIC_TAGS:
        value = values.get(tag)
        columns.extend([f"{tag}_sum", f"{tag}_min", f"{tag}_max"])
        row_values.extend([value if value is not None else 0, value, value])
        updates.append(f"{tag}_sum = {tag}_sum + excluded.{tag}_sum")
        updates.append(
            f"{tag}_min = CASE "
            f"WHEN {tag}_min IS NULL THEN excluded.{tag}_min "
            f"WHEN excluded.{tag}_min IS NULL THEN {tag}_min "
            f"WHEN excluded.{tag}_min < {tag}_min THEN excluded.{tag}_min "
            f"ELSE {tag}_min END"
        )
        updates.append(
            f"{tag}_max = CASE "
            f"WHEN {tag}_max IS NULL THEN excluded.{tag}_max "
            f"WHEN excluded.{tag}_max IS NULL THEN {tag}_max "
            f"WHEN excluded.{tag}_max > {tag}_max THEN excluded.{tag}_max "
            f"ELSE {tag}_max END"
        )

    placeholders = ",".join("?" for _ in columns)
    conn.execute(
        f"""
        INSERT INTO telemetry_rollup ({','.join(columns)})
        VALUES ({placeholders})
        ON CONFLICT(bucket_start, bucket_seconds, unit) DO UPDATE SET
            {', '.join(updates)}
        """,
        row_values,
    )


def insert_event(
    event_type: str,
    payload: dict[str, Any],
    db_path: str | None = None,
    topic: str | None = None,
) -> None:
    init_db(db_path)
    ts = iso(parse_timestamp(payload.get("timestamp")))
    event_payload = dict(payload)
    if topic:
        event_payload["_topic"] = topic

    severity = payload.get("severity")
    tag = payload.get("tag")
    score = payload.get("score")
    message = (
        payload.get("message")
        or payload.get("probable_cause")
        or payload.get("headline")
        or payload.get("answer")
    )
    with connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO historian_events
                (ts, event_type, severity, tag, score, message, payload_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                ts,
                event_type,
                severity,
                tag,
                _float_or_none(score),
                message,
                json.dumps(event_payload, separators=(",", ":"), default=str),
            ),
        )


# ── Clock-time / explicit-range parsing (operator-local time) ───────────────
# Turns phrases like "yesterday 11am-5pm", "between 9:00 and 14:00 today", or
# "from noon to 5pm on july 3" into a concrete [start, end) window. Clock times
# are read in the operator's LOCAL timezone; the tz-aware datetimes returned here
# are converted to UTC downstream by iso() when the SQL query is built.

_MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}

# One clock time: "11", "11:30", "5pm", "11 am", "noon", "midnight".
_TIME_CORE = r"(noon|midnight|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)"
_RANGE_PATTERNS = (
    re.compile(r"between\s+" + _TIME_CORE + r"\s+and\s+" + _TIME_CORE),
    re.compile(r"from\s+" + _TIME_CORE + r"\s+to\s+" + _TIME_CORE),
    re.compile(_TIME_CORE + r"\s*(?:-|–|—|to)\s*" + _TIME_CORE),
)


def _parse_clock_token(tok: str) -> tuple[int, int, bool] | None:
    """Return (hour, minute, had_meridiem) for a single clock token, or None."""
    t = tok.strip().lower()
    if t == "noon":
        return (12, 0, True)
    if t == "midnight":
        return (0, 0, True)
    m = re.match(r"^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$", t)
    if not m:
        return None
    hour = int(m.group(1))
    minute = int(m.group(2) or 0)
    ap = m.group(3)
    if ap == "am" and hour == 12:
        hour = 0
    elif ap == "pm" and hour != 12:
        hour += 12
    if hour > 23 or minute > 59:
        return None
    return (hour, minute, ap is not None)


_MONTH_NAMES = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec"
# "july 4", "july 4th", "4th july", "4 july", "4th of july".
_DATE_MONTH_DAY = re.compile(r"\b(" + _MONTH_NAMES + r")[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b")
_DATE_DAY_MONTH = re.compile(r"\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(" + _MONTH_NAMES + r")[a-z]*\b")
_DATE_ISO = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")
_DATE_NUMERIC = re.compile(r"\b(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?\b")  # day/month(/year)


def _make_date(year: int, month: int, day: int, today):
    """Build a date, rolling to last year if it lands in the future."""
    try:
        d = datetime(year, month, day).date()
    except ValueError:
        return None
    if d > today:  # a date later than today almost certainly means last year
        try:
            d = datetime(year - 1, month, day).date()
        except ValueError:
            return None
    return d


def _parse_explicit_date(q: str, current_local: datetime):
    """
    Resolve an explicit CALENDAR date in the question to (date, label), or None.
    Handles month names in either order with optional ordinals ("4th july",
    "july 4"), ISO dates, and day/month numeric dates. Does NOT match
    yesterday/today (handled separately).
    """
    today = current_local.date()

    m = _DATE_MONTH_DAY.search(q)
    if m:
        d = _make_date(today.year, _MONTHS[m.group(1)[:3]], int(m.group(2)), today)
        if d:
            return d, d.strftime("%b %d").replace(" 0", " ")

    m = _DATE_DAY_MONTH.search(q)
    if m:
        d = _make_date(today.year, _MONTHS[m.group(2)[:3]], int(m.group(1)), today)
        if d:
            return d, d.strftime("%b %d").replace(" 0", " ")

    m = _DATE_ISO.search(q)
    if m:
        d = _make_date(int(m.group(1)), int(m.group(2)), int(m.group(3)), today)
        if d:
            return d, d.isoformat()

    m = _DATE_NUMERIC.search(q)
    if m:
        year = today.year if not m.group(3) else int(m.group(3)) + (2000 if len(m.group(3)) == 2 else 0)
        d = _make_date(year, int(m.group(2)), int(m.group(1)), today)  # day/month order
        if d:
            return d, d.strftime("%b %d").replace(" 0", " ")

    return None


def _find_all_explicit_dates(q: str, current_local: datetime):
    """
    Return every explicit calendar date mentioned in q as (position, date),
    ordered by where it appears. Used to detect multi-day ranges like
    "from july 1 to july 4". Same date grammar as _parse_explicit_date.
    """
    today = current_local.date()
    found = []
    for m in _DATE_MONTH_DAY.finditer(q):
        d = _make_date(today.year, _MONTHS[m.group(1)[:3]], int(m.group(2)), today)
        if d:
            found.append((m.start(), d))
    for m in _DATE_DAY_MONTH.finditer(q):
        d = _make_date(today.year, _MONTHS[m.group(2)[:3]], int(m.group(1)), today)
        if d:
            found.append((m.start(), d))
    for m in _DATE_ISO.finditer(q):
        d = _make_date(int(m.group(1)), int(m.group(2)), int(m.group(3)), today)
        if d:
            found.append((m.start(), d))
    for m in _DATE_NUMERIC.finditer(q):
        year = today.year if not m.group(3) else int(m.group(3)) + (2000 if len(m.group(3)) == 2 else 0)
        d = _make_date(year, int(m.group(2)), int(m.group(1)), today)
        if d:
            found.append((m.start(), d))
    found.sort(key=lambda pos_date: pos_date[0])
    return found


def _parse_explicit_date_range(q: str, current_local: datetime):
    """
    Resolve a multi-day calendar date range ("from july 1 to july 4",
    "july 1 - 4 july", "between 2024-07-01 and 2024-07-04") to (start_date,
    end_date, label), or None. Requires two distinct dates joined by a range
    connector, so unrelated mentions ("compare july 1 and july 4 efficiency")
    are not misread as a span. Dates are returned earliest-first regardless of
    the order written.
    """
    dates = _find_all_explicit_dates(q, current_local)
    if len(dates) < 2:
        return None
    (p1, d1), (p2, d2) = dates[0], dates[1]
    if d1 == d2:
        return None
    connector = q[p1:p2]
    if not re.search(r"\b(to|through|thru|till|until|and)\b|[-–—]", connector):
        return None
    start_date, end_date = sorted((d1, d2))
    label = (
        f"{start_date.strftime('%b %d').replace(' 0', ' ')} - "
        f"{end_date.strftime('%b %d').replace(' 0', ' ')}"
    )
    return start_date, end_date, label


def _parse_date_anchor(q: str, current_local: datetime):
    """Resolve the calendar day a clock range sits on. Returns (date, label)."""
    today = current_local.date()
    if "yesterday" in q:
        return today - timedelta(days=1), "yesterday"
    explicit = _parse_explicit_date(q, current_local)
    if explicit:
        return explicit
    return today, "today"


def _parse_clock_range(q: str, current: datetime, return_future: bool = False):
    """
    Parse an explicit clock-time range into (start_local, end_local, label), or
    None when the phrase has no two-sided clock range. tz-aware, operator-local.

    return_future=True: when the whole window lies in the future (e.g. "between
    2pm and 6pm" asked at 10am), return ("future", start_local, end_local, label)
    with the UNclamped times instead of None, so callers can explain that the
    window has not happened yet rather than silently doing something else.
    """
    for pattern in _RANGE_PATTERNS:
        m = pattern.search(q)
        if not m:
            continue
        start = _parse_clock_token(m.group(1))
        end = _parse_clock_token(m.group(2))
        if not start or not end:
            continue

        matched = m.group(0)
        has_signal = bool(re.search(r"am|pm|:|noon|midnight", matched))
        # 24h values (>12) also prove it is a clock range, not e.g. "3 to 5 days".
        if not (has_signal or start[0] > 12 or end[0] > 12
                or "yesterday" in q or "today" in q):
            continue

        s_h, s_m, s_ap = start
        e_h, e_m, e_ap = end
        # "2 to 5pm" -> the pm on the later token carries to the earlier one.
        if not s_ap and e_ap and e_h >= 12 and s_h < 12:
            s_h += 12

        anchor, date_label = _parse_date_anchor(q, now_local(current))
        tz = local_tz()
        start_local = datetime(anchor.year, anchor.month, anchor.day, s_h, s_m, tzinfo=tz)
        end_local = datetime(anchor.year, anchor.month, anchor.day, e_h, e_m, tzinfo=tz)
        if end_local <= start_local:  # crosses midnight, or midnight-as-end-of-day
            end_local += timedelta(days=1)

        now_l = now_local(current)
        if return_future and start_local >= now_l:  # whole window still in the future
            label = f"{date_label} {start_local:%H:%M}-{end_local:%H:%M}"
            return "future", start_local, end_local, label
        end_local = min(end_local, now_l)  # never query into the future
        earliest = now_l - timedelta(days=RETENTION_DAYS)
        start_local = max(start_local, earliest)
        if end_local <= start_local:  # window entirely in the future / out of range
            return None

        label = f"{date_label} {start_local:%H:%M}-{end_local:%H:%M}"
        return start_local, end_local, label
    return None


# One clock time with an unambiguous signal (am/pm, a colon, or noon/midnight),
# so a bare day number like the "4" in "july 4" is never misread as a time.
_SINGLE_CLOCK = re.compile(r"\b(noon|midnight|\d{1,2}:\d{2}\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm))\b")


def _first_clock_time(text: str):
    """Return (hour, minute, had_meridiem) for the first signalled clock time, or None."""
    m = _SINGLE_CLOCK.search(text)
    if not m:
        return None
    return _parse_clock_token(m.group(1))


def _side_date(text: str, current: datetime):
    """Resolve the calendar date named in one side of a range, or None."""
    today = now_local(current).date()
    if "yesterday" in text:
        return today - timedelta(days=1)
    if re.search(r"\btoday\b", text):
        return today
    explicit = _parse_explicit_date(text, current)
    return explicit[0] if explicit else None


def _parse_single_clock_time(q: str, current: datetime):
    """
    Resolve a single clock time point (not a range) to (hour, minute), or None.
    Callers pair it with a date anchor to locate the shift that contains it.
    """
    t = _first_clock_time(q)
    if not t:
        return None
    return t[0], t[1]


_DT_RANGE_SPLITS = (
    re.compile(r"\bfrom\b(.+?)\bto\b(.+)"),
    re.compile(r"\bbetween\b(.+?)\band\b(.+)"),
    re.compile(r"(.+?)\bto\b(.+)"),
)


def _parse_datetime_range(q: str, current: datetime):
    """
    Cross-day explicit range where each side carries its own date AND time, e.g.
    "from july 4th 3pm to july 5th 2am". Returns (start_local, end_local, label)
    with UNclamped local datetimes, or None. Only fires when both sides have a
    signalled clock time and the two dates differ — a same-day range is left to
    _parse_clock_range, and a pure date range to _parse_explicit_date_range.
    """
    tz = local_tz()
    for splitter in _DT_RANGE_SPLITS:
        m = splitter.search(q)
        if not m:
            continue
        left, right = m.group(1), m.group(2)
        lt = _first_clock_time(left)
        rt = _first_clock_time(right)
        if not lt or not rt:
            continue
        ldate = _side_date(left, current)
        rdate = _side_date(right, current)
        if ldate is None and rdate is None:
            continue  # no explicit date -> same-day clock-range handler owns it
        ldate = ldate or rdate
        rdate = rdate or ldate
        if ldate == rdate:
            continue  # same day -> _parse_clock_range handles it
        start_local = datetime(ldate.year, ldate.month, ldate.day, lt[0], lt[1], tzinfo=tz)
        end_local = datetime(rdate.year, rdate.month, rdate.day, rt[0], rt[1], tzinfo=tz)
        if end_local <= start_local:
            continue
        label = f"{start_local:%b %d %H:%M} - {end_local:%b %d %H:%M}"
        return start_local, end_local, label
    return None


def _llm_extract_time_range(question: str, current: datetime):
    """
    Groq LLM fallback for phrasings the regex misses (e.g. "the first two hours
    after 8am yesterday"). Returns (start_local, end_local, label) or None.
    Self-contained (no ai_analyst import) to avoid a circular dependency.
    """
    api_key = os.environ.get("GROQ_API_KEY", "")
    if not api_key:
        return None
    try:
        import requests
    except Exception:
        return None

    now_l = now_local(current)
    model = os.environ.get("GROQ_ROUTER_MODEL", "qwen/qwen3.6-27b")
    url = os.environ.get("GROQ_CHAT_URL", "https://api.groq.com/openai/v1/chat/completions")
    system = (
        "You extract a time window from an operator's question about historical "
        "boiler data. 'Now' in the operator's local time is "
        f"{now_l:%Y-%m-%d %H:%M} ({now_l.tzname()}). "
        "Reply with ONLY JSON: {\"start_local\":\"YYYY-MM-DD HH:MM\","
        "\"end_local\":\"YYYY-MM-DD HH:MM\"} for a concrete past window, or "
        "{\"none\":true} if the question names no time window. Local time, 24h."
    )
    try:
        resp = requests.post(
            url,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": question},
                ],
                "temperature": 0.0,
                # Room for the full <think> trace AND the JSON after it; too small
                # a budget truncates before the closing </think> and the answer
                # (this model's self-verification can run long, but is fast on Groq).
                "max_tokens": 2048,
                # No response_format: this reasoning model emits a <think> block
                # first, which fails Groq's json_object validation. We strip the
                # think block and extract the JSON ourselves below instead.
            },
            # Generous: the reasoning trace before the JSON can take several seconds.
            timeout=20,
        )
        if resp.status_code != 200:
            return None
        text = resp.json()["choices"][0]["message"]["content"] or ""
    except Exception:
        return None

    # Only trust JSON emitted AFTER the reasoning block. If the block never closed
    # (reasoning truncated), don't scrape half-formed JSON out of the reasoning.
    if "<think>" in text and "</think>" not in text:
        return None
    if "</think>" in text:
        text = text.split("</think>")[-1]
    text = text.strip()

    data = None
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        a, b = text.find("{"), text.rfind("}")
        if a != -1 and b > a:
            try:
                data = json.loads(text[a:b + 1])
            except ValueError:
                data = None
    if not isinstance(data, dict) or data.get("none"):
        return None

    # Small models drift on key names and datetime format — accept the variants.
    tz = local_tz()
    start_local = _to_local_dt(data.get("start_local") or data.get("start_time") or data.get("start"), tz)
    end_local = _to_local_dt(data.get("end_local") or data.get("end_time") or data.get("end"), tz)
    if not start_local or not end_local:
        return None

    end_local = min(end_local, now_l)
    start_local = max(start_local, now_l - timedelta(days=RETENTION_DAYS))
    if end_local <= start_local:
        return None
    label = f"{start_local:%Y-%m-%d %H:%M}-{end_local:%H:%M}"
    return start_local, end_local, label


def _to_local_dt(value: Any, tz) -> datetime | None:
    """Parse a model-supplied datetime (ISO with offset, or 'YYYY-MM-DD HH:MM')
    into a tz-aware local datetime; naive values are assumed local."""
    if not value:
        return None
    text = str(value).strip().replace("Z", "+00:00")
    dt = None
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M"):
            try:
                dt = datetime.strptime(text, fmt)
                break
            except ValueError:
                continue
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=tz)
    return dt.astimezone(tz)


def parse_time_range(question: str, now: datetime | None = None) -> tuple[datetime, datetime, str]:
    current = now or utc_now()
    q = question.lower()

    # Explicit clock-time range first, e.g. "yesterday 11am-5pm" (local time).
    clock = _parse_clock_range(q, current)
    if clock:
        return clock

    match = re.search(
        r"last\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|"
        r"eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|"
        r"eighteen|nineteen|twenty|thirty|forty|fifty|sixty|ninety)\s*"
        r"(minute|minutes|min|hour|hours|day|days|week|weeks|month|months)",
        q,
    )
    if match:
        amount_text = match.group(1)
        amount = int(amount_text) if amount_text.isdigit() else NUMBER_WORDS[amount_text]
        unit = match.group(2)
        if unit.startswith("min"):
            delta = timedelta(minutes=amount)
        elif unit.startswith("hour"):
            delta = timedelta(hours=amount)
        elif unit.startswith("day"):
            delta = timedelta(days=amount)
        elif unit.startswith("week"):
            delta = timedelta(weeks=amount)
        else:
            delta = timedelta(days=30 * amount)
        start = current - delta
        return start, current, f"last {amount} {unit}"

    if "yesterday" in q:
        local_midnight = now_local(current).replace(hour=0, minute=0, second=0, microsecond=0)
        return local_midnight - timedelta(days=1), local_midnight, "yesterday"
    if "today" in q:
        local_midnight = now_local(current).replace(hour=0, minute=0, second=0, microsecond=0)
        return local_midnight, now_local(current), "today"
    if "this shift" in q or "current shift" in q:
        return current - timedelta(hours=8), current, "current shift"
    if "last shift" in q or "previous shift" in q:
        end = current - timedelta(hours=8)
        return end - timedelta(hours=8), end, "last shift"
    if "last month" in q:
        return current - timedelta(days=30), current, "last month"
    if "last week" in q:
        return current - timedelta(days=7), current, "last week"
    if "3 month" in q or "three month" in q or "quarter" in q:
        return current - timedelta(days=90), current, "last 3 months"

    # A bare calendar date with no clock range means the WHOLE day, e.g.
    # "efficiency for 4th july" -> local midnight..midnight (clamped to now).
    explicit_date = _parse_explicit_date(q, now_local(current))
    if explicit_date:
        d, dlabel = explicit_date
        tz = local_tz()
        start = datetime(d.year, d.month, d.day, tzinfo=tz)
        end = min(start + timedelta(days=1), now_local(current))
        if end > start:
            return start, end, dlabel

    # LLM fallback for unusual phrasings the regex above could not resolve.
    llm = _llm_extract_time_range(question, current)
    if llm:
        return llm

    return current - timedelta(hours=1), current, "last 1 hour"


def infer_tags(question: str) -> list[str]:
    q = question.lower()
    tags: list[str] = []
    for tag, aliases in TAG_ALIASES.items():
        if any(re.search(r"(?<![a-z0-9])" + re.escape(alias) + r"(?![a-z0-9])", q) for alias in aliases):
            tags.append(tag)
    if tags:
        return tags
    if any(word in q for word in ("efficiency", "loss", "down", "drop", "fuel", "why")):
        return ["efficiency", "fuel_flow", "steam_flow", "flue_gas_temp", "o2_percent", "tube_health"]
    return ["steam_pressure", "drum_level", "efficiency", "tube_health", "flue_gas_temp", "o2_percent"]


def is_historical_question(question: str) -> bool:
    q = question.lower()
    historical_terms = (
        "yesterday",
        "today",
        "shift",
        "last ",
        "past ",
        "week",
        "month",
        "3 month",
        "three month",
        "history",
        "historian",
        "trend",
        "average",
        "avg",
        "minimum",
        "maximum",
        "highest",
        "lowest",
        "worst",
        "best",
        "how many",
        "count",
        "compare",
        "before",
        "between",
    )
    if any(term in q for term in historical_terms):
        return True
    # Explicit clock times ("11am", "17:00"), month names, or "from X to Y" all
    # imply a historical window even without a keyword above.
    return bool(_HAS_EXPLICIT_TIME.search(q))


# am/pm or HH:MM clock times, calendar dates (month name in either order with
# optional ordinal, ISO, or day/month numeric), or "from ... to" range phrasing.
_HAS_EXPLICIT_TIME = re.compile(
    r"\b\d{1,2}\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b|"
    r"\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?\b|"
    r"\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|"
    r"\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}/\d{1,2}(?:/\d{2,4})?\b|"
    r"\bfrom\s+\d.*\bto\s+\d",
    re.IGNORECASE,
)


def _bucket_for_range(start: datetime, end: datetime) -> int:
    seconds = max(1, int((end - start).total_seconds()))
    if seconds <= 2 * 3600:
        return 60
    if seconds <= 3 * 24 * 3600:
        return 300
    if seconds <= 14 * 24 * 3600:
        return 3600
    return 6 * 3600


def _row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row is not None else None


def _baseline_comparison(tags: list[str], stats: dict[str, Any]) -> dict[str, Any]:
    comparisons: dict[str, Any] = {}
    for tag in tags:
        baseline = BASELINES.get(tag)
        avg = stats.get(f"{tag}_avg")
        if baseline is None or avg is None:
            continue
        delta = avg - baseline
        comparisons[tag] = {
            "avg": avg,
            "baseline": baseline,
            "delta": delta,
            "delta_pct": (delta / baseline * 100.0) if baseline else None,
            "status": "above_baseline" if delta > 0 else "below_baseline" if delta < 0 else "at_baseline",
        }
    return comparisons


def latest(tags: list[str] | None = None, db_path: str | None = None) -> dict[str, Any]:
    init_db(db_path)
    wanted = tags or NUMERIC_TAGS
    columns = ["ts", "mode", *[tag for tag in wanted if tag in NUMERIC_TAGS]]
    with connect(db_path) as conn:
        row = conn.execute(
            f"SELECT {','.join(columns)} FROM telemetry_raw ORDER BY ts DESC LIMIT 1"
        ).fetchone()
    return {"available": row is not None, "row": _row_to_dict(row)}


def window_stats(tags: list[str], start: datetime, end: datetime, db_path: str | None = None) -> dict[str, Any]:
    init_db(db_path)
    safe_tags = [tag for tag in tags if tag in NUMERIC_TAGS]
    if not safe_tags:
        safe_tags = ["efficiency", "steam_pressure", "drum_level"]
    bucket_seconds = _bucket_for_range(start, end)
    if bucket_seconds >= 3600:
        select_parts = ["SUM(count) AS samples"]
        for tag in safe_tags:
            select_parts.extend([
                f"SUM({tag}_sum) / NULLIF(SUM(count), 0) AS {tag}_avg",
                f"MIN({tag}_min) AS {tag}_min",
                f"MAX({tag}_max) AS {tag}_max",
            ])
        with connect(db_path) as conn:
            row = conn.execute(
                f"""
                SELECT {', '.join(select_parts)}
                FROM telemetry_rollup
                WHERE bucket_seconds = 3600 AND bucket_start >= ? AND bucket_start < ?
                """,
                (iso(start), iso(end)),
            ).fetchone()
        summary = dict(row) if row else {"samples": 0}
        return {
            "start": iso(start),
            "end": iso(end),
            "source": "rollup_1h",
            "tags": safe_tags,
            "stats": summary,
            "baseline_comparison": _baseline_comparison(safe_tags, summary),
        }

    select_parts = ["COUNT(*) AS samples"]
    for tag in safe_tags:
        select_parts.extend([
            f"AVG({tag}) AS {tag}_avg",
            f"MIN({tag}) AS {tag}_min",
            f"MAX({tag}) AS {tag}_max",
        ])
    with connect(db_path) as conn:
        row = conn.execute(
            f"""
            SELECT {', '.join(select_parts)}
            FROM telemetry_raw
            WHERE ts >= ? AND ts < ?
            """,
            (iso(start), iso(end)),
        ).fetchone()
    summary = dict(row) if row else {"samples": 0}
    return {
        "start": iso(start),
        "end": iso(end),
        "source": "raw",
        "tags": safe_tags,
        "stats": summary,
        "baseline_comparison": _baseline_comparison(safe_tags, summary),
    }


def trend(tags: list[str], start: datetime, end: datetime, db_path: str | None = None) -> dict[str, Any]:
    init_db(db_path)
    safe_tags = [tag for tag in tags if tag in NUMERIC_TAGS][:8]
    bucket_seconds = _bucket_for_range(start, end)
    if bucket_seconds in (60, 3600) and (end - start).total_seconds() > 3600:
        select_parts = ["bucket_start AS ts", "SUM(count) AS samples"]
        for tag in safe_tags:
            select_parts.append(f"SUM({tag}_sum) / NULLIF(SUM(count), 0) AS {tag}_avg")
        with connect(db_path) as conn:
            rows = conn.execute(
                f"""
                SELECT {', '.join(select_parts)}
                FROM telemetry_rollup
                WHERE bucket_seconds = ? AND bucket_start >= ? AND bucket_start < ?
                GROUP BY bucket_start
                ORDER BY bucket_start
                LIMIT 500
                """,
                (bucket_seconds, iso(start), iso(end)),
            ).fetchall()
        return {
            "start": iso(start),
            "end": iso(end),
            "source": f"rollup_{bucket_seconds}s",
            "bucket_seconds": bucket_seconds,
            "tags": safe_tags,
            "points": [dict(row) for row in rows],
        }

    bucket_expr = f"(CAST(strftime('%s', ts) AS INTEGER) / {bucket_seconds}) * {bucket_seconds}"
    select_parts = [f"{bucket_expr} AS bucket_epoch", "COUNT(*) AS samples"]
    for tag in safe_tags:
        select_parts.append(f"AVG({tag}) AS {tag}_avg")
    with connect(db_path) as conn:
        rows = conn.execute(
            f"""
            SELECT {', '.join(select_parts)}
            FROM telemetry_raw
            WHERE ts >= ? AND ts < ?
            GROUP BY bucket_epoch
            ORDER BY bucket_epoch
            LIMIT 500
            """,
            (iso(start), iso(end)),
        ).fetchall()
    points = []
    for row in rows:
        item = dict(row)
        bucket_ts = datetime.fromtimestamp(item.pop("bucket_epoch"), tz=timezone.utc)
        item["ts"] = iso(bucket_ts)
        points.append(item)
    return {
        "start": iso(start),
        "end": iso(end),
        "source": "raw",
        "bucket_seconds": bucket_seconds,
        "tags": safe_tags,
        "points": points,
    }


def find_extreme(tag: str, start: datetime, end: datetime, mode: str, db_path: str | None = None) -> dict[str, Any]:
    init_db(db_path)
    safe_tag = tag if tag in NUMERIC_TAGS else "efficiency"
    direction = "ASC" if mode == "min" else "DESC"
    with connect(db_path) as conn:
        row = conn.execute(
            f"""
            SELECT ts, mode, {safe_tag} AS value
            FROM telemetry_raw
            WHERE ts >= ? AND ts < ? AND {safe_tag} IS NOT NULL
            ORDER BY {safe_tag} {direction}
            LIMIT 1
            """,
            (iso(start), iso(end)),
        ).fetchone()
    return {
        "tag": safe_tag,
        "mode": mode,
        "start": iso(start),
        "end": iso(end),
        "point": _row_to_dict(row),
    }


def event_timeline(start: datetime, end: datetime, db_path: str | None = None) -> dict[str, Any]:
    init_db(db_path)
    with connect(db_path) as conn:
        counts = conn.execute(
            """
            SELECT event_type, COALESCE(severity, '') AS severity, COUNT(*) AS count
            FROM historian_events
            WHERE ts >= ? AND ts < ?
            GROUP BY event_type, severity
            ORDER BY event_type, severity
            """,
            (iso(start), iso(end)),
        ).fetchall()
        recent = conn.execute(
            """
            SELECT ts, event_type, severity, tag, score, message
            FROM historian_events
            WHERE ts >= ? AND ts < ?
            ORDER BY ts DESC
            LIMIT 20
            """,
            (iso(start), iso(end)),
        ).fetchall()
    return {
        "start": iso(start),
        "end": iso(end),
        "counts": [dict(row) for row in counts],
        "recent": [dict(row) for row in recent],
    }


def compare_windows(tags: list[str], start: datetime, end: datetime, db_path: str | None = None) -> dict[str, Any]:
    duration = end - start
    prev_start = start - duration
    current = window_stats(tags, start, end, db_path)
    previous = window_stats(tags, prev_start, start, db_path)
    deltas: dict[str, Any] = {}
    for tag in current["tags"]:
        curr = current["stats"].get(f"{tag}_avg")
        prev = previous["stats"].get(f"{tag}_avg")
        if curr is not None and prev is not None:
            delta = curr - prev
            deltas[tag] = {
                "current_avg": curr,
                "previous_avg": prev,
                "delta": delta,
                "delta_pct": (delta / prev * 100.0) if prev else None,
            }
    return {
        "current": current,
        "previous": previous,
        "deltas": deltas,
    }


def _linear_slope(values: list[float]) -> float | None:
    if len(values) < 2:
        return None
    xs = list(range(len(values)))
    mean_x = statistics.mean(xs)
    mean_y = statistics.mean(values)
    denom = sum((x - mean_x) ** 2 for x in xs)
    if denom == 0:
        return None
    return sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, values)) / denom


def _mentions(q: str, terms: tuple[str, ...]) -> bool:
    for term in terms:
        pattern = r"(?<![a-z0-9])" + re.escape(term) + r"(?![a-z0-9])"
        if re.search(pattern, q):
            return True
    return False


def _humanize_tag(tag: str) -> str:
    return tag.replace("_", " ")


def _format_baseline_delta(tag: str, value: float | None) -> str:
    baseline = BASELINES.get(tag)
    if baseline is None or value is None:
        return ""
    delta = value - baseline
    if delta > 0:
        return f", {delta:.2f} points above the {baseline:.2f} baseline"
    if delta < 0:
        return f", {abs(delta):.2f} points below the {baseline:.2f} baseline"
    return f", equal to the {baseline:.2f} baseline"


def _explicit_tags(question: str, tags: list[str]) -> list[str]:
    q = question.lower()
    explicit = []
    for tag in tags:
        aliases = TAG_ALIASES.get(tag, ())
        if any(re.search(r"(?<![a-z0-9])" + re.escape(alias) + r"(?![a-z0-9])", q) for alias in aliases):
            explicit.append(tag)
    return explicit


def _historian_operation(question: str) -> str:
    q = question.lower()
    if _mentions(q, ("compare", "versus", "vs")) or "than last" in q or "than previous" in q or "than yesterday" in q:
        return "compare"
    if _mentions(q, ("highest", "maximum", "max", "peak", "best")):
        return "max"
    if _mentions(q, ("lowest", "minimum", "min", "worst")):
        return "min"
    return "avg"


def _asks_for_explanation(question: str) -> bool:
    q = question.lower()
    return _mentions(q, ("why", "cause", "reason", "because", "diagnose", "explain")) or "root cause" in q


def answer_historical_metric_question(question: str, db_path: str | None = None) -> str | None:
    if _asks_for_explanation(question) or not is_historical_question(question):
        return None

    tags = _explicit_tags(question, infer_tags(question))
    if not tags:
        return None

    start, end, label = parse_time_range(question)
    operation = _historian_operation(question)

    if operation == "compare":
        result = compare_windows(tags, start, end, db_path)
        parts = []
        for tag in result.get("current", {}).get("tags", tags):
            delta_info = result.get("deltas", {}).get(tag)
            if not delta_info:
                continue
            delta = delta_info.get("delta")
            direction = "up" if delta and delta > 0 else "down" if delta and delta < 0 else "unchanged"
            parts.append(
                f"{_humanize_tag(tag)} averaged {delta_info['current_avg']:.2f} in {label}, "
                f"{direction} {abs(delta):.2f} from the previous matching window"
            )
        return ". ".join(parts) + "." if parts else f"No comparable samples were found for {label}."

    if operation in ("min", "max"):
        parts = []
        for tag in tags:
            result = find_extreme(tag, start, end, operation, db_path)
            point = result.get("point")
            if not point or point.get("value") is None:
                parts.append(f"No stored {_humanize_tag(tag)} samples were found for {label}")
                continue
            label_word = "highest" if operation == "max" else "lowest"
            value = point["value"]
            parts.append(
                f"The {label_word} {_humanize_tag(tag)} over {label} was {value:.2f} "
                f"at {point.get('ts')}{_format_baseline_delta(tag, value)}"
            )
        return ". ".join(parts) + "."

    stats = window_stats(tags, start, end, db_path)
    summary = stats.get("stats", {})
    samples = summary.get("samples")
    sample_text = f" across {samples} samples" if samples is not None else ""
    parts = []
    for tag in stats.get("tags", tags):
        avg = summary.get(f"{tag}_avg")
        minimum = summary.get(f"{tag}_min")
        maximum = summary.get(f"{tag}_max")
        if avg is None:
            parts.append(f"No stored {_humanize_tag(tag)} samples were found for {label}")
            continue
        range_text = ""
        if minimum is not None and maximum is not None:
            range_text = f", ranging from {minimum:.2f} to {maximum:.2f}"
        parts.append(
            f"The average {_humanize_tag(tag)} over {label} was {avg:.2f}"
            f"{_format_baseline_delta(tag, avg)}{range_text}{sample_text}"
        )
    return ". ".join(parts) + "."


def _fmt_value(tag: str, value: Any, digits: int = 2) -> str:
    if value is None:
        return "n/a"
    unit = UNITS.get(tag, "")
    try:
        numeric = float(value)
        text = f"{numeric:.{digits}f}"
    except (TypeError, ValueError):
        text = str(value)
    return f"{text} {unit}".strip()


def _event_count(events: dict[str, Any], event_type: str | None = None, severity: str | None = None) -> int:
    total = 0
    for row in events.get("counts", []):
        if event_type is not None and row.get("event_type") != event_type:
            continue
        if severity is not None and row.get("severity") != severity:
            continue
        total += int(row.get("count") or 0)
    return total


# Urgency buckets — mirror how Honeywell/Siemens APM tools schedule work orders.
WHEN_NOW = "Now"
WHEN_SHIFT = "This shift"
WHEN_WEEK = "This week"
WHEN_OUTAGE = "Next outage"


def _priority_line(rank: int, item: dict[str, Any]) -> str:
    """Operator-grade text fallback (used for chat history + non-card clients)."""
    evidence = "; ".join(item.get("evidence", [])[:3])
    parts = [f"{rank}. [{item['when']}] {item['task']} ({item['discipline']})."]
    if item.get("impact"):
        parts.append(f"Why: {item['impact']}")
    if item.get("detail"):
        parts.append(f"Do: {item['detail']}")
    if evidence:
        parts.append(f"Evidence: {evidence}.")
    return " ".join(parts)


def is_maintenance_priority_question(question: str) -> bool:
    q = question.lower()
    return (
        ("maintenance" in q or "team" in q or "prioritize" in q or "priority" in q)
        and any(term in q for term in ("prioritize", "priority", "this week", "week", "order", "backlog", "work"))
    )


def _trend_series(tag: str, start: datetime, end: datetime, db_path: str | None) -> list[float]:
    """Ordered list of bucketed averages for a tag over a window (for slope detection)."""
    points = trend([tag], start, end, db_path).get("points", [])
    return [p[f"{tag}_avg"] for p in points if p.get(f"{tag}_avg") is not None]


def answer_maintenance_priority_question(question: str, db_path: str | None = None) -> dict[str, Any] | None:
    """
    Build a ranked, operator-facing maintenance work list.

    Two horizons are combined the way plant APM software does:
      • a 7-day *acute* window for excursions that need action now, and
      • a 30-day *trend* window that surfaces slow degradation (tube-health
        decline, efficiency drift) a 7-day view would miss.

    Returns a structured dict ({"type": "maintenance_priorities", ...}) so the
    dashboard can render priority cards, plus a plain-text "answer" fallback.
    """
    if not is_maintenance_priority_question(question):
        return None

    tags = [
        "efficiency", "o2_percent", "fuel_flow", "air_flow", "flue_gas_temp",
        "tube_health", "drum_level", "feedwater_flow", "steam_pressure", "safety_valve",
    ]
    end = utc_now()
    start = end - timedelta(days=7)
    month_start = end - timedelta(days=30)

    stats = window_stats(tags, start, end, db_path)
    month_stats = window_stats(tags, month_start, end, db_path)
    events = event_timeline(start, end, db_path)
    summary = stats.get("stats", {})
    samples = int(summary.get("samples") or 0)
    month_samples = int(month_stats.get("stats", {}).get("samples") or 0)

    window_label = "last 7 days + 30-day trend"

    if samples == 0:
        text = (
            "No historian samples are available for the last 7 days, so build this week's "
            "maintenance list from live alarms and field rounds."
        )
        return {
            "type": "maintenance_priorities",
            "answer": text,
            "summary": text,
            "window": window_label,
            "samples_7d": 0,
            "samples_30d": month_samples,
            "priorities": [],
            "note": "Inspection / work-order priorities — not automatic control changes.",
        }

    items: list[dict[str, Any]] = []
    anomaly_count = _event_count(events, "anomaly_score")
    alert_count = _event_count(events, "alert")

    # ── Combustion / excess-air (7-day acute) ──────────────────────────────
    o2_avg = summary.get("o2_percent_avg")
    o2_min = summary.get("o2_percent_min")
    fuel_avg = summary.get("fuel_flow_avg")
    air_avg = summary.get("air_flow_avg")
    if o2_min is not None and o2_min < 2.0:
        items.append({
            "key": "combustion",
            "score": 95 + min(20, int((2.0 - o2_min) * 10)),
            "task": "Calibrate O₂ analyzer and verify the burner air path",
            "when": WHEN_SHIFT,
            "discipline": "I&C + Combustion",
            "severity": "critical",
            "impact": "Low O₂ risks incomplete combustion and CO — correct before any load increase.",
            "detail": "Check analyzer span, fan inlet, damper feedback, and fuel/air trim.",
            "evidence": [
                f"O₂ dipped to {_fmt_value('o2_percent', o2_min)} (safe floor 2.00 %)",
                f"O₂ averaged {_fmt_value('o2_percent', o2_avg)} over 7 days",
                f"fuel {_fmt_value('fuel_flow', fuel_avg)} vs air {_fmt_value('air_flow', air_avg)}",
            ],
        })
    elif o2_avg is not None and o2_avg > 4.0:
        items.append({
            "key": "combustion",
            "score": 74 + min(15, int((o2_avg - 4.0) * 8)),
            "task": "Trim excess air and check the O₂ analyzer",
            "when": WHEN_WEEK,
            "discipline": "I&C + Combustion",
            "severity": "warning",
            "impact": "Excess air above the 2–4 % band wastes fuel as stack loss.",
            "detail": "Inspect damper linkage, analyzer calibration, burner registers, and casing air leaks.",
            "evidence": [
                f"O₂ averaged {_fmt_value('o2_percent', o2_avg)} (target 2–4 %)",
                f"O₂ minimum {_fmt_value('o2_percent', o2_min)}",
            ],
        })

    # ── Pressure / safety valve (7-day acute) ──────────────────────────────
    pressure_max = summary.get("steam_pressure_max")
    safety_valve_max = summary.get("safety_valve_max")
    if safety_valve_max and safety_valve_max >= 1:
        items.append({
            "key": "pressure",
            "score": 100,
            "task": "Investigate the safety-valve lift",
            "when": WHEN_NOW,
            "discipline": "Mechanical + Operations",
            "severity": "critical",
            "impact": "The valve lifted, so pressure went above the set point. Check the valve closed properly before running again.",
            "detail": "Review the high-pressure event, confirm the valve closed properly, and inspect the discharge line per site procedure.",
            "evidence": [
                "Safety valve indicated OPEN during the weekly window",
                f"peak steam pressure {_fmt_value('steam_pressure', pressure_max)}",
            ],
        })
    elif pressure_max is not None and pressure_max > 13.0:
        items.append({
            "key": "pressure",
            "score": 88 + min(10, int((pressure_max - 13.0) * 10)),
            "task": "Review the high-pressure events",
            "when": WHEN_WEEK,
            "discipline": "I&C + Operations",
            "severity": "high",
            "impact": "High-pressure events reduce the safety margin before the safety valve lifts at 13.5 bar.",
            "detail": "Check pressure transmitter calibration, demand swings, and outlet restrictions.",
            "evidence": [
                f"peak steam pressure {_fmt_value('steam_pressure', pressure_max)}",
                "high-pressure events reduce the safety margin",
            ],
        })

    # ── Drum level / feedwater (7-day acute) ───────────────────────────────
    drum_min = summary.get("drum_level_min")
    drum_max = summary.get("drum_level_max")
    fw_avg = summary.get("feedwater_flow_avg")
    if (drum_min is not None and drum_min < 280) or (drum_max is not None and drum_max > 600):
        worst = []
        if drum_min is not None:
            worst.append(f"min {_fmt_value('drum_level', drum_min)}")
        if drum_max is not None:
            worst.append(f"max {_fmt_value('drum_level', drum_max)}")
        items.append({
            "key": "drum",
            "score": 86,
            "task": "Verify drum-level instrumentation and feedwater stability",
            "when": WHEN_WEEK,
            "discipline": "I&C + Mechanical",
            "severity": "high",
            "impact": "Level swings outside the 280–600 mm band risk low-water or carryover trips.",
            "detail": "Compare gauge glass to transmitter, inspect feedwater valve feedback, pump recirculation, and impulse lines.",
            "evidence": [
                "drum level range " + ", ".join(worst),
                f"feedwater flow average {_fmt_value('feedwater_flow', fw_avg)}",
            ],
        })

    # ── Heat transfer / tube health (7-day acute) ──────────────────────────
    tube_avg = summary.get("tube_health_avg")
    tube_min = summary.get("tube_health_min")
    fgt_max = summary.get("flue_gas_temp_max")
    eff_avg = summary.get("efficiency_avg")
    tube_item: dict[str, Any] | None = None
    if (tube_min is not None and tube_min < 96.5) or (fgt_max is not None and fgt_max > 220) or (eff_avg is not None and eff_avg < BASELINES["efficiency"] - 2):
        score = 72
        if tube_min is not None and tube_min < 96.0:
            score += 8
        if fgt_max is not None and fgt_max > 220:
            score += 10
        if eff_avg is not None and eff_avg < BASELINES["efficiency"] - 2:
            score += 8
        tube_item = {
            "key": "tube",
            "score": score,
            "task": "Inspect heat-transfer surfaces and tube health",
            "when": WHEN_WEEK,
            "discipline": "Mechanical",
            "severity": "warning",
            "impact": "Rising flue-gas temp with falling tube health points to fireside fouling and lost efficiency.",
            "detail": "Schedule a fireside inspection/cleaning review; check soot and scale indicators.",
            "evidence": [
                f"tube health minimum {_fmt_value('tube_health', tube_min)}",
                f"flue gas maximum {_fmt_value('flue_gas_temp', fgt_max)}",
                f"efficiency average {_fmt_value('efficiency', eff_avg)}",
            ],
        }
        items.append(tube_item)
    elif tube_avg is not None and tube_avg < BASELINES["tube_health"]:
        tube_item = {
            "key": "tube",
            "score": 62,
            "task": "Keep tube health on weekly watch",
            "when": WHEN_WEEK,
            "discipline": "Reliability",
            "severity": "low",
            "impact": "Tube health is below baseline but not yet actionable — watch the slope.",
            "detail": "Add tube-health review to weekly rounds and compare next week before scheduling outage work.",
            "evidence": [
                f"tube health average {_fmt_value('tube_health', tube_avg)} below baseline {_fmt_value('tube_health', BASELINES['tube_health'])}",
                f"minimum tube health {_fmt_value('tube_health', tube_min)}",
            ],
        }
        items.append(tube_item)

    # ── Alert / anomaly triage (7-day acute) ───────────────────────────────
    if anomaly_count or alert_count:
        items.append({
            "key": "triage",
            "score": min(92, 58 + anomaly_count * 3 + alert_count * 5),
            "task": "Triage recurring alerts and anomalies",
            "when": WHEN_WEEK,
            "discipline": "I&C",
            "severity": "warning",
            "impact": "Repeated events mask real faults and drive alarm fatigue.",
            "detail": "Cluster events by tag, validate the noisiest transmitter, and close stale alarms before changing controls.",
            "evidence": [
                f"{anomaly_count} anomaly-score events in the last 7 days",
                f"{alert_count} alert events in the last 7 days",
            ],
        })

    # ── 30-day trend enrichment ────────────────────────────────────────────
    # Slow degradation the 7-day window can't see. Augments the acute tube item
    # if present, otherwise raises its own trend-based work item.
    if month_samples > 0:
        th_series = _trend_series("tube_health", month_start, end, db_path)
        if len(th_series) >= 2:
            th_drop = th_series[0] - th_series[-1]
            if th_drop >= 0.5:
                th_line = (
                    f"30-day tube health {th_series[0]:.1f}% → {th_series[-1]:.1f}% "
                    f"({th_drop:.1f} pt drop)"
                )
                if tube_item is not None:
                    tube_item["evidence"].append(th_line)
                    tube_item["score"] += min(12, int(th_drop * 3))
                    if th_drop >= 2 and tube_item["severity"] in ("low", "warning"):
                        tube_item["severity"] = "high"
                else:
                    items.append({
                        "key": "tube_trend",
                        "score": 70 + min(15, int(th_drop * 3)),
                        "task": "Project tube-health decline before the next outage",
                        "when": WHEN_OUTAGE if th_drop < 3 else WHEN_WEEK,
                        "discipline": "Reliability",
                        "severity": "high" if th_drop >= 3 else "warning",
                        "impact": f"Tube health fell {th_drop:.1f} points over 30 days — estimate remaining life and pre-stage cleaning.",
                        "detail": "Overlay the 30-day tube-health trend with flue-gas temp; if the slope holds, schedule inspection for the next outage window.",
                        "evidence": [th_line],
                    })

        eff_series = _trend_series("efficiency", month_start, end, db_path)
        if len(eff_series) >= 2:
            eff_drop = eff_series[0] - eff_series[-1]
            if eff_drop >= 1.0:
                items.append({
                    "key": "eff_trend",
                    "score": 68 + min(15, int(eff_drop * 3)),
                    "task": "Address the 30-day efficiency drift",
                    "when": WHEN_WEEK,
                    "discipline": "Performance",
                    "severity": "warning",
                    "impact": f"Efficiency drifted down {eff_drop:.1f} points over 30 days, raising fuel cost.",
                    "detail": "Correlate with O₂ trim, flue-gas temp, and tube health to isolate the dominant loss; verify combustion tuning.",
                    "evidence": [
                        f"30-day efficiency {eff_series[0]:.1f}% → {eff_series[-1]:.1f}% ({eff_drop:.1f} pt drop)",
                    ],
                })

    if not items:
        text = (
            f"Historian shows {samples} samples over the last 7 days ({month_samples} over 30 days) "
            "and no high-priority maintenance triggers. Prioritize routine rounds: verify O₂ analyzer span, "
            "compare drum gauge glass to transmitter, review the alarm log, and inspect for leaks or abnormal noise."
        )
        return {
            "type": "maintenance_priorities",
            "answer": text,
            "summary": text,
            "window": window_label,
            "samples_7d": samples,
            "samples_30d": month_samples,
            "priorities": [],
            "note": "Inspection / work-order priorities — not automatic control changes.",
        }

    items.sort(key=lambda item: item["score"], reverse=True)
    top = items[:5]

    priorities: list[dict[str, Any]] = []
    for rank, item in enumerate(top, 1):
        priorities.append({
            "rank": rank,
            "task": item["task"],
            "when": item["when"],
            "discipline": item["discipline"],
            "severity": item["severity"],
            "impact": item.get("impact", ""),
            "detail": item.get("detail", ""),
            "evidence": item.get("evidence", [])[:3],
        })

    summary = (
        f"{len(priorities)} maintenance priorities from the last 7 days "
        f"({samples} samples; {month_samples} over 30 days)."
    )
    lines = [summary]
    lines.extend(_priority_line(p["rank"], p) for p in priorities)
    lines.append("Inspection / work-order priorities — not automatic control changes.")

    return {
        "type": "maintenance_priorities",
        "answer": "\n".join(lines),
        "summary": summary,
        "window": window_label,
        "samples_7d": samples,
        "samples_30d": month_samples,
        "priorities": priorities,
        "note": "Inspection / work-order priorities — not automatic control changes.",
    }


def explain_efficiency_context(start: datetime, end: datetime, db_path: str | None = None) -> dict[str, Any]:
    tags = ["efficiency", "fuel_flow", "steam_flow", "flue_gas_temp", "o2_percent", "tube_health"]
    stats = window_stats(tags, start, end, db_path)
    points = trend(tags, start, end, db_path)["points"]
    worst = find_extreme("efficiency", start, end, "min", db_path)
    signals: dict[str, Any] = {}
    for tag in tags:
        values = [p.get(f"{tag}_avg") for p in points if p.get(f"{tag}_avg") is not None]
        if values:
            signals[tag] = {
                "first": values[0],
                "last": values[-1],
                "change": values[-1] - values[0],
                "slope_per_bucket": _linear_slope(values),
                "baseline": BASELINES.get(tag),
            }
    return {
        "kind": "efficiency_root_cause_context",
        "stats": stats,
        "worst_efficiency": worst,
        "signals": signals,
        "events": event_timeline(start, end, db_path),
    }


def build_historian_context(question: str, db_path: str | None = None) -> str:
    if not is_historical_question(question):
        return ""

    start, end, label = parse_time_range(question)
    tags = infer_tags(question)
    q = question.lower()

    try:
        if _mentions(q, ("alert", "alarm", "anomaly", "incident", "event", "how many", "count")):
            result = {
                "kind": "event_timeline",
                "range_label": label,
                "data": event_timeline(start, end, db_path),
            }
        elif _mentions(q, ("compare", "versus", "vs", "than yesterday", "than last")):
            result = {
                "kind": "compare_windows",
                "range_label": label,
                "data": compare_windows(tags, start, end, db_path),
            }
        elif _mentions(q, ("highest", "maximum", "max", "peak")):
            result = {
                "kind": "extreme",
                "range_label": label,
                "data": find_extreme(tags[0], start, end, "max", db_path),
            }
        elif _mentions(q, ("lowest", "minimum", "min", "worst")):
            target = "efficiency" if "worst" in q and "efficiency" in tags else tags[0]
            result = {
                "kind": "extreme",
                "range_label": label,
                "data": find_extreme(target, start, end, "min", db_path),
            }
        elif "efficiency" in tags and _mentions(q, ("why", "down", "drop", "loss", "cause")):
            result = {
                "kind": "efficiency_explanation",
                "range_label": label,
                "data": explain_efficiency_context(start, end, db_path),
            }
        elif _mentions(q, ("trend", "over time", "history", "show")):
            result = {
                "kind": "trend",
                "range_label": label,
                "data": trend(tags, start, end, db_path),
            }
        else:
            result = {
                "kind": "window_stats",
                "range_label": label,
                "data": window_stats(tags, start, end, db_path),
            }
    except sqlite3.Error as exc:
        return (
            "HISTORIAN CONTEXT:\n"
            f"Historian query failed: {exc}. Use live telemetry only and say historical data is unavailable.\n"
        )

    return (
        "HISTORIAN CONTEXT (queried from local SQLite historian; treat as ground truth):\n"
        f"{json.dumps(result, indent=2, default=str)}\n\n"
        "Historian response rules: cite the queried time range, sample count when present, "
        "and say when there are no stored samples. Do not invent missing historical values.\n"
    )
