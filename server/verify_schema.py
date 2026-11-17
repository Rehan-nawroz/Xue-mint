"""Applies the initial schema to a fresh throwaway database and prints the tables.

Run from the server folder:
    python verify_schema.py

Exit code 0 = schema applied cleanly. Any error = schema problem.
The throwaway database file is created in the system temp folder and deleted after.
"""
import os
import sqlite3
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA = os.path.join(HERE, "migrations", "0001_init.sql")

EXPECTED_TABLES = {"assets", "devices", "settings", "uploads"}

def main():
    tmp = os.path.join(tempfile.gettempdir(), "xue_mint_schema_check.db")
    if os.path.exists(tmp):
        os.remove(tmp)
    conn = sqlite3.connect(tmp)
    try:
        with open(SCHEMA, encoding="utf-8") as f:
            conn.executescript(f.read())
        tables = set(
            r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        )
        print("Tables created:", sorted(tables))
        missing = EXPECTED_TABLES - tables
        if missing:
            print("MISSING TABLES:", sorted(missing))
            raise SystemExit(1)
        # Quick sanity insert/delete on each table so constraints are exercised.
        conn.execute(
            "INSERT INTO devices (id, name, public_key, credential, paired_at) "
            "VALUES ('test', 'test', x'00', 'test', '2025-01-01T00:00:00Z')"
        )
        conn.execute(
            "INSERT INTO assets (id, hash, type, size, path, added_at) "
            "VALUES ('t', 'h', 'photo', 1, 'p', '2025-01-01T00:00:00Z')"
        )
        conn.execute(
            "INSERT INTO uploads (id, device_id, hash, total) "
            "VALUES ('u', 'test', 'h', 10)"
        )
        conn.execute("INSERT INTO settings (key, value) VALUES ('k', 'v')")
        conn.commit()
        print("Insert smoke test passed on all four tables.")
        print("Schema applied cleanly to a fresh database.")
    finally:
        conn.close()
        if os.path.exists(tmp):
            os.remove(tmp)

if __name__ == "__main__":
    main()
