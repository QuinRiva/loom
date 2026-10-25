#!/usr/bin/env bash
# Child delegation rate per role: children created on or after SINCE, and how many spawned a child themselves.
# Usage: delegation.sh SINCE [DB]   (SINCE: an ISO date or UTC timestamp, e.g. 2026-10-13 or 2026-10-22T23:04:44Z)
# A child is a workstream row with a parent and a kickoff. Read-only against the live cockpit database
# (mode=ro, never immutable=1: that ignores the WAL and reads stale data).
set -euo pipefail
since=${1:?usage: delegation.sh SINCE [DB]}
db=${2:-${T3CODE_HOME:-$HOME/.t3/cockpit}/userdata/statev2.sqlite}
[[ $since =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9:.]+Z?)?$ ]] || { echo "bad SINCE: $since" >&2; exit 2; }
[[ -f $db ]] || { echo "no database at $db" >&2; exit 2; }
sqlite3 -header "file:$db?mode=ro" "
with children as (
  select thread_id, role, created_at
  from loom_thread_workstream
  where parent_thread_id is not null and kickoff_at is not null
),
parents as (
  select distinct parent_thread_id p
  from loom_thread_workstream
  where parent_thread_id is not null
)
select role,
       count(*) as children,
       sum(exists(select 1 from parents where p = children.thread_id)) as delegated
from children
where created_at >= '$since'
group by role
order by children desc;"
