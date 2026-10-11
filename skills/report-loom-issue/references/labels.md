# Labels on `QuinRiva/loom` used by `report-loom-issue`

Every issue the script files carries five or six labels: its kind (`bug` or
`enhancement`), `needs-triage`, one `origin:`, one `confidence:`, one `surface:`
and, when flagged, `needs-design`. The caller chooses them only through the
script's flags. All must exist before the script can run —
`gh issue create` refuses the whole issue on any unknown label.

## Reused (already exist)

| Label          | Role here                                 |
| -------------- | ----------------------------------------- |
| `bug`          | `--kind bug`: something misbehaves        |
| `enhancement`  | `--kind enhancement`: a capability/change |
| `needs-triage` | A human has not looked yet                |

## Created for this skill

Create idempotently, once, from this table:

```bash
gh label create <name> -R QuinRiva/loom --color <hex> --description "<text>" --force
```

| Label                      | Colour   | Description                                                                                     |
| -------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `origin:agent`             | `5319E7` | An agent hit this side-on and filed it (incl. when it asked first and a person agreed)          |
| `origin:human`             | `0E8A16` | A person hit this and asked an agent to file it; the body quotes their words                    |
| `needs-design`             | `D93F0B` | Outcome depends on the maintainer's judgement; not for unattended implementation                |
| `confidence:confirmed`     | `B60205` | Reporter reproduced it or read the path end-to-end; Evidence shows it                           |
| `confidence:suspected`     | `FBCA04` | Looks wrong but unverified; reporter may be misreading Loom                                     |
| `surface:web`              | `1D76DB` | Triage starts in the web/desktop UI (apps/web, apps/desktop)                                    |
| `surface:server`           | `1D76DB` | Triage starts in the T3 server (apps/server): threads, turns, persistence, adapter              |
| `surface:workstream-tools` | `1D76DB` | Triage starts in the pi tools Loom injects: workstream/goal tools, consult/notify, gates        |
| `surface:roles-skills`     | `1D76DB` | Triage starts in roles/, skills/, the AGENTS overlay or the work-model doctrine text            |
| `surface:cockpit`          | `1D76DB` | Triage starts in release/deploy: loom-releases, deployctl, systemd unit, skill linking          |
| `surface:pi`               | `1D76DB` | Triage starts in pi upstream (@earendil-works/pi-coding-agent); filed here, not on pi's tracker |

`confidence:` and `surface:` follow the repo's existing prefixed facets
(`vouch:`, `size:`); a bare `confirmed` beside `vouch:trusted` would read as
another vouching state.

## Not for agents

`duplicate`, `invalid`, `wontfix` and closing an issue are the triaging human's
moves. The script never applies them and a reporting thread
never should.
