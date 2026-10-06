#!/bin/bash
# QA-ONLY. Builds the QA pi agent directory (PI_CODING_AGENT_DIR of the QA unit;
# recorded fact 4), as Phase 3's smoke built its own:
#   auth.json      copy of ~/.pi/agent/auth.json (model credentials; pi refreshes them here, never globally)
#   cliproxy.apikey  copy of the cliproxy INFERENCE key (the unit cannot see ~/cli-proxy)
#   settings.json  copy of ~/.pi/agent/settings.json without packages/subagents/memory
#   models.json    generated: pi-craft's cliproxy provider (cliproxy.ts) re-expressed against the
#                  bundled pi's own anthropic catalogue (cliproxy.ts calls getBuiltinModels("anthropic"))
#   extensions/pi-anthropic-messages/   a COPY of the global package (without it every cliproxy/*
#                  request fails "400 Third-party apps now draw from extra usage")
# Nothing else: no pi-intercom or other global extension (run-starting ones would wake QA pi
# processes), no skills (Loom's composer passes role skills with --skill from the build).
#   usage: build-pi-agent.sh <target-dir> [<loom checkout for the bundled pi-ai catalogue>]
set -euo pipefail
source "$(dirname "$0")/lib.sh"
target=$1
checkout=${2:-$(realpath "$QA_TOOLKIT/../..")}
[[ $target == /home/Carl/.t3/qa-*/pi-agent ]] || qa_die "pi agent target $target is not <QA home>/pi-agent"
[[ ! -e $target ]] || qa_die "$target exists"
cliproxy_ts=/home/Carl/pi-craft/plugins/pi-craft/extensions/cliproxy.ts
bridge_ext=$PROD_PI_AGENT/npm/node_modules/@blackbelt-technology/pi-anthropic-messages
pi_pkg=$(realpath "$checkout/apps/server/node_modules/@earendil-works/pi-coding-agent")
pi_ai=$(realpath "$pi_pkg/../pi-ai")

mkdir -p "$target/extensions"
install -m 600 "$PROD_PI_AGENT/auth.json" "$target/auth.json"
jq 'del(.packages, .subagents, .memory)' "$PROD_PI_AGENT/settings.json" >"$target/settings.json"
cp -r "$bridge_ext" "$target/extensions/pi-anthropic-messages"

# cliproxy.ts is the source of truth for the provider's base URL, auth and headers;
# read them from it so a change there cannot silently diverge from this copy.
base_url=$(grep -oP 'baseUrl:\s*"\K[^"]+' "$cliproxy_ts" | head -1)
api_key=$(grep -oP 'apiKey:\s*"\K[^"]+' "$cliproxy_ts" | head -1)
betas=$(sed -n '/"anthropic-beta": \[/,/\]\.join/p' "$cliproxy_ts" | grep -oP '^\s*"\K[a-z0-9-]+(?=",)' | paste -sd,)
grep -q 'sendSessionAffinityHeaders: true' "$cliproxy_ts" || qa_die "cliproxy.ts no longer sets sendSessionAffinityHeaders — re-read it"
grep -q 'getBuiltinModels("anthropic")' "$cliproxy_ts" || qa_die "cliproxy.ts no longer derives its catalogue from pi's anthropic models — re-read it"
[[ $base_url && $api_key && $betas ]] || qa_die "could not read baseUrl/apiKey/anthropic-beta from $cliproxy_ts"
# Inside the unit "localhost" must be the IPv4 relay to the cliproxy bridge.
base_url=${base_url/localhost/127.0.0.1}
# The unit cannot see ~/cli-proxy: copy the INFERENCE key it names (never .mgmtkey) into the agent dir.
[[ $api_key =~ ^!cat\ (/home/Carl/cli-proxy/\.apikey)$ ]] || qa_die "cliproxy.ts apiKey is not '!cat /home/Carl/cli-proxy/.apikey' — re-read it"
install -m 600 "${BASH_REMATCH[1]}" "$target/cliproxy.apikey"
api_key="!cat $target/cliproxy.apikey"

"$QA_NODE" --input-type=module - "$pi_ai/dist/providers/all.js" "$base_url" "$api_key" "$betas" >"$target/models.json" <<'EOF'
const [catalogue, baseUrl, apiKey, betas] = process.argv.slice(2);
const { getBuiltinModels } = await import(catalogue);
const keep = ["id", "name", "api", "reasoning", "thinkingLevelMap", "input", "inputLimits", "cost",
  "promptCache", "contextWindow", "maxTokens", "headers", "compat"];
const models = getBuiltinModels("anthropic").map((m) => ({
  ...Object.fromEntries(keep.filter((k) => m[k] !== undefined).map((k) => [k, m[k]])),
  name: `${m.name} (pooled)`,
  compat: { ...m.compat, sendSessionAffinityHeaders: true },
}));
const provider = { name: "Claude (pooled subs)", baseUrl, api: "anthropic-messages", apiKey,
  headers: { "anthropic-beta": betas }, models };
console.log(JSON.stringify({ providers: { cliproxy: provider } }, null, 2));
EOF
qa_log "pi-agent: $(jq '.providers.cliproxy.models | length' "$target/models.json") cliproxy models from $(jq -r .version "$pi_ai/package.json") pi-ai, baseUrl $base_url, $(tr ',' '\n' <<<"$betas" | wc -l) betas; extension $(jq -r '.name+"@"+.version' "$target/extensions/pi-anthropic-messages/package.json"); settings keys: $(jq -c keys "$target/settings.json")"
