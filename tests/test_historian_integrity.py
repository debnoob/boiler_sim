"""Historian database integrity + quarantine tests.

A malformed SQLite file does not fail loudly on open — a corrupt db.corrupt
sitting in this repo went unnoticed for five days because nothing checked. This
pins the fix: startup must detect corruption, move the bad file aside without
losing it, and start clean instead of silently degrading every historical
question to "data unavailable".

All tests operate on files under tmp_path — never the real historian database.
"""

from pathlib import Path

from historian_client import check_integrity, init_db, insert_heartbeat, quarantine_corrupt_db


def _make_malformed_db(path):
    """A file that looks enough like SQLite to open, but fails integrity_check."""
    path.write_bytes(b"SQLite format 3\x00" + b"\x00" * 4080 + b"garbage, not a real page")


def test_no_file_is_not_treated_as_corruption(tmp_path):
    ok, detail = check_integrity(str(tmp_path / "nowhere.db"))
    assert ok is True
    assert "no existing" in detail


def test_healthy_db_passes(tmp_path):
    db_path = str(tmp_path / "healthy.db")
    init_db(db_path)
    insert_heartbeat({"tags": {"steam_pressure": 10.1}, "mode": "NORMAL", "tick": 1}, db_path)
    ok, detail = check_integrity(db_path)
    assert ok is True
    assert detail == "ok"


def test_malformed_db_is_detected(tmp_path):
    db_path = tmp_path / "broken.db"
    _make_malformed_db(db_path)
    ok, detail = check_integrity(str(db_path))
    assert ok is False
    assert "malformed" in detail or "not a database" in detail


def test_quarantine_moves_the_file_and_leaves_original_path_free(tmp_path):
    db_path = tmp_path / "broken.db"
    _make_malformed_db(db_path)
    quarantined = quarantine_corrupt_db(str(db_path))
    assert not db_path.exists()
    assert Path(quarantined).exists()


def test_quarantine_moves_wal_and_shm_sidecars_together(tmp_path):
    """A prior real incident left an orphaned -wal/-shm pair with no main file,
    because only the main file had been moved. Sidecars must travel with it."""
    db_path = tmp_path / "broken.db"
    _make_malformed_db(db_path)
    (tmp_path / "broken.db-wal").write_bytes(b"wal-data")
    (tmp_path / "broken.db-shm").write_bytes(b"shm-data")

    quarantined = quarantine_corrupt_db(str(db_path))

    assert not (tmp_path / "broken.db-wal").exists()
    assert not (tmp_path / "broken.db-shm").exists()
    assert Path(quarantined + "-wal").exists()
    assert Path(quarantined + "-shm").exists()


def test_quarantine_then_fresh_init_produces_a_working_database(tmp_path):
    """The exact sequence historian_service.py runs at startup."""
    db_path = str(tmp_path / "broken.db")
    _make_malformed_db(tmp_path / "broken.db")

    ok, _ = check_integrity(db_path)
    assert ok is False
    quarantine_corrupt_db(db_path)

    init_db(db_path)
    insert_heartbeat({"tags": {"steam_pressure": 10.1}, "mode": "NORMAL", "tick": 1}, db_path)

    ok, detail = check_integrity(db_path)
    assert ok is True, detail


def test_quarantine_preserves_bytes_exactly(tmp_path):
    """Quarantine is a rename, not a copy-and-touch — whatever pages a tool like
    `sqlite3 <file> ".recover"` could salvage before the move must be exactly as
    salvageable after it. A byte-for-byte match is the correct guarantee here:
    it proves nothing about content was altered, which is what recoverability
    actually depends on."""
    db_path = tmp_path / "broken.db"
    _make_malformed_db(db_path)
    original_bytes = db_path.read_bytes()

    quarantined = quarantine_corrupt_db(str(db_path))

    assert Path(quarantined).read_bytes() == original_bytes
