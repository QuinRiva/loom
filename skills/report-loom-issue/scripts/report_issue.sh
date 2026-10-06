#!/usr/bin/env bash
# report_issue.sh — park a Loom bug as a GitHub issue on QuinRiva/loom.
# Contract (flags, validation order, leak guard, duplicate check, footer, exit
# codes) is ../SKILL.md. Issue URL on stdout; everything else on stderr.
set -euo pipefail

REPO=QuinRiva/loom
TEMPLATE="$(dirname "$0")/../references/issue-template.md"
die() { echo "error: $1" >&2; exit 1; }

summary="" confidence="" surface="" description="" force=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --summary) summary="$2"; shift 2 ;;
    --confidence) confidence="$2"; shift 2 ;;
    --surface) surface="$2"; shift 2 ;;
    --description) description="$2"; shift 2 ;;
    --description-file) [[ -f "$2" ]] || die "--description-file not found: $2"; description=$(<"$2"); shift 2 ;;
    --force) force=true; shift ;;
    --template) cat "$TEMPLATE"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -n "$summary" && "$summary" != *$'\n'* ]] || die "--summary is required: one line, the observable symptom, not your theory of the cause."
[[ "$confidence" =~ ^(confirmed|suspected)$ ]] || die "--confidence must be 'confirmed' (reproduced / read end-to-end) or 'suspected' (unverified; the honest default)."
[[ "$surface" =~ ^(web|server|workstream-tools|roles-skills|cockpit|pi)$ ]] || die "--surface must be one of: web server workstream-tools roles-skills cockpit pi"

# --- Template: the three sections that make a finding triageable ---
missing=()
for s in "Evidence" "Not verified" "Alternative explanations"; do
  grep -qiP "^#+\s*$s" <<<"$description" || missing+=("$s")
done
if [[ -z "$description" ]] || (( ${#missing[@]} )); then
  { if [[ -z "$description" ]]; then echo "error: a description is required (--description-file or --description)."
    else echo "error: description is missing required section heading(s): $(printf "\"%s\" " "${missing[@]}")"; fi
    echo; echo "Template:"; echo; cat "$TEMPLATE"; } >&2
  exit 1
fi

# --- Leak guard: refuse, never scrub. No override. ---
leaked=false
while IFS='|' read -r name re; do
  hits=$( { grep -iP -- "$re" <<<"$summary" | sed 's/^/  summary: /'
            grep -niP -- "$re" <<<"$description" | sed 's/^/  body line /'; } || true)
  [[ -n "$hits" ]] && { leaked=true; printf 'leak guard: %s (%s)\n%s\n' "$name" "$re" "$hits" >&2; }
done <<'EOF'
private org/client/host|Stratus-Labs|fathom|exomnia|unseen\.id|unseen_training|carl-dev|\.ts\.net
Jira key|\bPE-\d{3,}\b|\bAIT-\d+\b
secret|Bearer\s+[A-Za-z0-9_.-]{20,}|T3_WORKSTREAM_AUTHORIZATION|GOOGLE_APPLICATION_CREDENTIALS|[?&#]token=[A-Za-z0-9_-]+
email|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}
machine path|/home/[^\s/]+/|worktrees/
EOF
if $leaked; then
  echo "Nothing created. The board is public: rewrite those passages (describe Loom's behaviour only) and re-run." >&2
  exit 2
fi

# --- Duplicate check: score open issue titles against summary keywords ---
keywords=$(grep -oP '[A-Za-z_][A-Za-z0-9_]{3,}' <<<"$summary" | tr '[:upper:]' '[:lower:]' \
  | grep -vxE 'when|while|with|without|from|into|onto|this|that|these|those|were|been|being|does|should|cannot|never|always|issue|error|problem|broken|fails|fail|failing|wrong|incorrect|seems|maybe|possible|possibly' \
  | awk '!seen[$0]++' | head -4 | xargs || true)
if [[ -n "$keywords" ]] && ! $force; then
  echo "Checking $REPO open issues for near-duplicates (keywords: $keywords)" >&2
  report=$(gh issue list -R "$REPO" -s open -L 500 --json number,title,url,labels | jq -r --arg kw "$keywords" '
    ($kw | split(" ")) as $k | ([2, ($k | length)] | min) as $min
    | [.[] | . as $i | {i: $i, h: [$k[] | select(. as $w | $i.title | ascii_downcase | contains($w))] | length} | select(.h > 0)]
    | sort_by(-.h) | (map(select(.h >= $min))) as $strong
    | (if ($strong | length) > 0 then "STRONG" elif length > 0 then "WEAK" else "NONE" end),
      ((if ($strong | length) > 0 then $strong else . end)[:8][]
       | "  #\(.i.number)  [\([.i.labels[].name] | join(",") | if . == "" then "-" else . end)]  \(.h)/\($k | length) keywords\n      \(.i.title)\n      \(.i.url)")') || exit 1
  case "$(head -1 <<<"$report")" in
    STRONG)
      cat >&2 <<EOF

STOP — nothing created. $REPO already has closely-related open issues:

$(tail -n +2 <<<"$report")

Decide, don't guess:
  * Same issue → add your sighting as a comment (end it with your thread id, \$PI_SESSION_ID):
      gh issue comment <n> -R $REPO -F <your-finding.md>
  * Genuinely different → re-run with --force and say in the body how it differs.
  * Unsure → gh issue view <n> -R $REPO --comments
EOF
      exit 3 ;;
    WEAK) printf 'No strong duplicate. Loosely related (proceeding):\n%s\n' "$(tail -n +2 <<<"$report")" >&2 ;;
    *) echo "No near-duplicates — proceeding." >&2 ;;
  esac
fi

# --- Footer: auto-captured context. The release is whatever server spawned our pi. ---
p=$$
while [[ "$p" -gt 1 && "$(cat /proc/$p/comm)" != pi ]]; do p=$(awk '{print $4}' /proc/$p/stat); done
release=unknown sha="" pi_version=unknown
if [[ "$p" -gt 1 ]]; then
  srv=$(readlink "/proc/$(awk '{print $4}' /proc/$p/stat)/cwd")
  [[ "$srv" == */loom-releases/releases/* ]] && release=$(basename "$srv") || release=dev
  sha=$(git -C "$srv" rev-parse HEAD)
  pi_version=$(jq -r .version "$srv/apps/server/node_modules/@earendil-works/pi-coding-agent/package.json" 2>/dev/null || echo unknown)
fi
project="a non-loom project"
[[ "$(git remote get-url origin 2>/dev/null | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##')" == "$REPO" ]] \
  && project="\`$REPO\` @ \`$(git branch --show-current)\` (\`$(git rev-parse --short HEAD)\`)"

body=$(mktemp)
trap 'rm -f "$body"' EXIT
cat >"$body" <<EOF
$description

---
Filed by an agent (\`report-loom-issue\`) under the human's account, found while working on $project.
- Loom release: \`$release\`${sha:+ — https://github.com/$REPO/tree/$sha}
- pi: \`$pi_version\` (bundled)
- Model: \`${PI_PROVIDER:-unknown}/${PI_MODEL:-unknown}\` (reasoning \`${PI_REASONING_LEVEL:-unknown}\`)
- Thread: \`${PI_SESSION_ID:-unknown}\`
- Confidence as filed: **$confidence**
EOF

echo "Filing $confidence surface:$surface issue on $REPO: $summary" >&2
url=$(gh issue create -R "$REPO" -t "$summary" -F "$body" \
  -l bug -l needs-triage -l agent-found -l "confidence:$confidence" -l "surface:$surface") || exit 1
cat >&2 <<EOF

Filed: $url (awaiting human triage)
Report the URL to the user / your parent in one line and carry on. Do not work on it unless a human asks.
EOF
echo "$url"
