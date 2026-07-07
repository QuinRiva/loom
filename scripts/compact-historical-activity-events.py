#!/usr/bin/env python3
"""One-off compaction for pre-fix fat thread activity events.

This is intentionally not a general event-store maintenance command. It removes
only historical pre-stable-id `tool.updated` activity ticks that are superseded
by a later update in the same inferred tool lifecycle. It keeps all
`tool.started`, all `tool.completed`, and the latest `tool.updated` per inferred
(thread, turn, item type, summary, started/completed-delimited lifecycle).

Run without --execute to inspect candidates. Destructive runs always take and
verify a fresh file-level SQLite backup before deleting anything, then VACUUM.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import sqlite3
import sys
from typing import Any

CANDIDATE_SQL = """
DROP TABLE IF EXISTS temp.superseded_activity_events;
CREATE TEMP TABLE superseded_activity_events AS
WITH tool_events AS (
  SELECT
    sequence,
    event_id,
    stream_id AS thread_id,
    json_extract(payload_json, '$.activity.id') AS activity_id,
    json_extract(payload_json, '$.activity.kind') AS kind,
    COALESCE(json_extract(payload_json, '$.activity.turnId'), '') AS turn_id,
    COALESCE(json_extract(payload_json, '$.activity.payload.itemType'), '') AS item_type,
    COALESCE(json_extract(payload_json, '$.activity.summary'), '') AS summary,
    LENGTH(payload_json) AS event_bytes,
    SUM(CASE WHEN json_extract(payload_json, '$.activity.kind') = 'tool.started' THEN 1 ELSE 0 END)
      OVER (
        PARTITION BY
          stream_id,
          COALESCE(json_extract(payload_json, '$.activity.turnId'), ''),
          COALESCE(json_extract(payload_json, '$.activity.payload.itemType'), ''),
          COALESCE(json_extract(payload_json, '$.activity.summary'), '')
        ORDER BY sequence
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ) AS tool_group
  FROM orchestration_events
  WHERE aggregate_kind = 'thread'
    AND event_type = 'thread.activity-appended'
    AND json_extract(payload_json, '$.activity.kind') IN ('tool.started', 'tool.updated', 'tool.completed')
    -- PR #55 gives tool lifecycle activities stable `tool:<toolCallId>` ids and
    -- a payload toolCallId. This one-off only targets older random-id ticks.
    AND COALESCE(json_extract(payload_json, '$.activity.id'), '') NOT LIKE 'tool:%'
    AND json_type(payload_json, '$.activity.payload.toolCallId') IS NULL
), ranked_updates AS (
  SELECT
    *,
    MAX(sequence) OVER (
      PARTITION BY thread_id, turn_id, item_type, summary, tool_group
    ) AS latest_update_sequence
  FROM tool_events
  WHERE kind = 'tool.updated'
)
SELECT
  sequence,
  event_id,
  activity_id,
  thread_id,
  turn_id,
  item_type,
  summary,
  tool_group,
  event_bytes
FROM ranked_updates
WHERE sequence <> latest_update_sequence;
"""


def connect(path: Path, *, write: bool) -> sqlite3.Connection:
    mode = "rw" if write else "ro"
    conn = sqlite3.connect(f"file:{path}?mode={mode}", uri=True, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 30000")
    return conn


def scalar(conn: sqlite3.Connection, sql: str, params: tuple[Any, ...] = ()) -> Any:
    return conn.execute(sql, params).fetchone()[0]


def table_counts(conn: sqlite3.Connection) -> dict[str, int]:
    tables = [
        row[0]
        for row in conn.execute(
            """
            SELECT name
            FROM sqlite_schema
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
            ORDER BY name
            """
        )
    ]
    return {table: int(scalar(conn, f'SELECT COUNT(*) FROM "{table}"')) for table in tables}


def verify_schema(conn: sqlite3.Connection) -> None:
    required = {"orchestration_events", "projection_thread_activities"}
    present = {
        row[0]
        for row in conn.execute(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN (?, ?)",
            tuple(required),
        )
    }
    missing = sorted(required - present)
    if missing:
        raise SystemExit(f"Not a loom state DB; missing tables: {', '.join(missing)}")


def make_backup(db_path: Path, backup_dir: Path, source_counts: dict[str, int]) -> Path:
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_path = backup_dir / f"{db_path.stem}-before-activity-compaction-{stamp}.sqlite"

    with connect(db_path, write=False) as source, sqlite3.connect(backup_path) as backup:
        source.backup(backup)

    with connect(backup_path, write=False) as backup:
        integrity = scalar(backup, "PRAGMA integrity_check")
        if integrity != "ok":
            raise SystemExit(f"Backup integrity_check failed: {integrity}")
        backup_counts = table_counts(backup)

    if backup_counts != source_counts:
        diff = {
            table: [source_counts.get(table), backup_counts.get(table)]
            for table in sorted(set(source_counts) | set(backup_counts))
            if source_counts.get(table) != backup_counts.get(table)
        }
        raise SystemExit(f"Backup row-count mismatch; refusing to proceed: {json.dumps(diff, indent=2)}")

    return backup_path


def build_candidates(conn: sqlite3.Connection) -> None:
    conn.executescript(CANDIDATE_SQL)


def stats(conn: sqlite3.Connection) -> dict[str, Any]:
    total = conn.execute(
        """
        SELECT COUNT(*) AS rows, COALESCE(SUM(event_bytes), 0) AS bytes
        FROM superseded_activity_events
        """
    ).fetchone()
    projection = conn.execute(
        """
        SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(p.payload_json)), 0) AS bytes
        FROM projection_thread_activities p
        JOIN superseded_activity_events s ON s.activity_id = p.activity_id
        """
    ).fetchone()
    by_item_type = [
        dict(row)
        for row in conn.execute(
            """
            SELECT
              item_type,
              COUNT(*) AS rows,
              COALESCE(SUM(event_bytes), 0) AS bytes,
              MIN(sequence) AS min_sequence,
              MAX(sequence) AS max_sequence
            FROM superseded_activity_events
            GROUP BY item_type
            ORDER BY bytes DESC
            """
        )
    ]
    return {
        "candidate_events": {"rows": total["rows"], "bytes": total["bytes"]},
        "candidate_projection_rows": {"rows": projection["rows"], "bytes": projection["bytes"]},
        "by_item_type": by_item_type,
    }


def compact(conn: sqlite3.Connection) -> dict[str, int]:
    conn.execute("BEGIN IMMEDIATE")
    try:
        projection_deleted = conn.execute(
            """
            DELETE FROM projection_thread_activities
            WHERE activity_id IN (SELECT activity_id FROM superseded_activity_events)
            """
        ).rowcount
        events_deleted = conn.execute(
            """
            DELETE FROM orchestration_events
            WHERE sequence IN (SELECT sequence FROM superseded_activity_events)
            """
        ).rowcount
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return {"events_deleted": events_deleted, "projection_rows_deleted": projection_deleted}


def human_size(size: int) -> str:
    for unit in ("B", "KiB", "MiB", "GiB"):
        if size < 1024 or unit == "GiB":
            return f"{size:.1f} {unit}" if unit != "B" else f"{size} B"
        size /= 1024
    return f"{size} B"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, type=Path, help="Path to loom state.sqlite")
    parser.add_argument(
        "--backup-dir",
        type=Path,
        help="Where destructive-run backups are written (default: <db-dir>/backups)",
    )
    parser.add_argument("--execute", action="store_true", help="Delete candidates and VACUUM")
    args = parser.parse_args()

    db_path = args.db.expanduser().resolve()
    if not db_path.exists() or db_path.stat().st_size == 0:
        raise SystemExit(f"DB path does not exist or is empty: {db_path}")

    size_before = db_path.stat().st_size
    with connect(db_path, write=args.execute) as conn:
        verify_schema(conn)
        source_counts = table_counts(conn)
        backup_path = None
        if args.execute:
            backup_path = make_backup(db_path, args.backup_dir or db_path.parent / "backups", source_counts)

        build_candidates(conn)
        before_stats = stats(conn)
        result: dict[str, Any] = {
            "db": str(db_path),
            "mode": "execute" if args.execute else "dry-run",
            "size_before": size_before,
            "size_before_human": human_size(size_before),
            "backup": str(backup_path) if backup_path else None,
            "before": before_stats,
        }

        if args.execute:
            result["deleted"] = compact(conn)
            conn.execute("VACUUM")
            integrity = scalar(conn, "PRAGMA integrity_check")
            checkpoint = list(conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone())
            result["integrity_check"] = integrity
            result["wal_checkpoint_truncate"] = checkpoint
            if integrity != "ok":
                raise SystemExit(f"Post-compaction integrity_check failed: {integrity}")

    if args.execute:
        size_after = db_path.stat().st_size
        result["size_after"] = size_after
        result["size_after_human"] = human_size(size_after)
        result["file_bytes_reclaimed"] = size_before - size_after
        result["file_reclaimed_human"] = human_size(max(0, size_before - size_after))
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
