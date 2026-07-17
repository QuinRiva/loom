// Fresh authoring generator for the tier-(b) validation slice (NOT the PE-1593
// generators). Builds a single self-contained .mdx decision surface from the
// real pack-2 verdict data, the T-5 title ruling, and FULL production taxonomy
// entries embedded under <Details> + <Json>, deliberately crossing 1 MiB so it
// exercises the large-doc renderer path end-to-end.
//
// Usage: node build.mjs > recap.mdx
import * as NodeFS from "node:fs";

const TIER_B =
  "/home/Carl/.roo/worktrees/PE-1593-taxonomy-relationship-semantics/data-pipeline-jobs/lease-extraction/scripts/fable5_tier_b/_data";
const TAXONOMY =
  "/home/Carl/.roo/worktrees/PE-1593-taxonomy-relationship-semantics/data-pipeline-jobs/lease-extraction/models/taxonomy_beta2_production.json";

const pack = JSON.parse(NodeFS.readFileSync(`${TIER_B}/pack2.json`, "utf8"));
const titles = JSON.parse(NodeFS.readFileSync(`${TIER_B}/titles.json`, "utf8"));
const production = JSON.parse(NodeFS.readFileSync(TAXONOMY, "utf8")).taxonomy;
const entryById = new Map(production.map((e) => [e.type_id, e]));

const TARGET_MIB = 1.15 * 1024 * 1024;

/* --------------------------- MDX attr helpers ---------------------------- */

const SAFE = /^[\w .:/@#,+()[\]-]+$/;
function attr(name, value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "boolean") return value ? ` ${name}` : "";
  if (typeof value === "number") return ` ${name}={${value}}`;
  if (typeof value === "string") {
    return SAFE.test(value) && value.length < 140
      ? ` ${name}="${value.replace(/"/g, "&quot;")}"`
      : ` ${name}={${JSON.stringify(value)}}`;
  }
  return ` ${name}={${JSON.stringify(value)}}`;
}
/** Escape MDX-significant characters in a prose paragraph. */
const prose = (text) => text.replace(/([<{}])/g, "\\$1");

/** Full production entry embedded as its own tens-of-KB <Json> drill-down. */
function entryJson(typeId) {
  const entry = entryById.get(typeId);
  if (!entry) return null;
  return `<Json${attr("title", `${typeId} — production entry`)}${attr(
    "json",
    JSON.stringify(entry, null, 2),
  )} collapsedDepth={1} />`;
}

const VERDICT_TONE = {
  REDIRECT: "info",
  REWRITE_AS_PROSE: "warning",
  GENUINE_GAP: "accent",
  LEGITIMATE_NON_TYPE: "neutral",
  SPLIT: "risk",
};

const out = [];
const push = (s) => out.push(s);
const bytes = () => Buffer.byteLength(out.join("\n\n"), "utf8");

/* -------------------------------- header --------------------------------- */

push(`# Tier-(b) taxonomy sign-off — Pack 2 (plan / drawing / spatial family)`);
push(
  `This is the fully evidence-embedded review surface for **pack 2** of the tier-(b) ` +
    `phantom-token campaign (${pack.counts.tokens} tokens, ${pack.counts.occurrences} occurrences) ` +
    `plus the **T-5** contested-title ruling. Every occurrence's verbatim before/after and the ` +
    `**full production taxonomy entry** for each affected type is embedded inline — nothing links out.`,
);

push(
  `<Callout tone="decision">\n\n` +
    `**Review protocol.** Each item carries its verdict, the verbatim occurrence edits, and the ` +
    `full production entries behind a drill-down. **Silence means you accept the recommendation** — ` +
    `only record a choice for items you want to reject or discuss. The "N of M decided" counter ` +
    `tracks explicit decisions; sign-off completes when the rejects/discussions are resolved.\n\n` +
    `</Callout>`,
);

/* -------------------------- filterable master table ----------------------- */

const rows = pack.tokens.map((t) => [
  `P2-${t.id}`,
  t.token,
  t.verdict,
  t.target ?? "—",
  String(t.occurrences),
]);
rows.push([
  "T-5",
  titles.items.find((i) => i.id === "T-5").contested_title,
  "CONTESTED_TITLE",
  "see ruling",
  "—",
]);
push(
  `## All items` +
    `\n\n<Table filterable${attr("columns", [
      "ID",
      "Token / title",
      "Verdict",
      "Target / disposition",
      "Occ",
    ])}${attr("rows", rows)} />`,
);

/* --------------------------- per-token item cards ------------------------- */

push(`## Pack 2 tokens`);

for (const token of pack.tokens) {
  const tone = VERDICT_TONE[token.verdict] ?? "neutral";
  const meta = [
    `${token.occurrences} occ`,
    `confidence: ${token.confidence}`,
    token.lineage_backed ? "lineage-backed" : "not lineage-backed",
  ];
  const fields = token.occ.map((o) => ({
    name: o.site,
    before: o.before,
    after: o.after,
    ...(o.edit ? {} : { kept: true }),
  }));

  // Full production entries: the redirect target + every occurrence's site type.
  const referenced = new Set();
  if (token.verdict === "REDIRECT" && entryById.has(token.target)) referenced.add(token.target);
  for (const o of token.occ) referenced.add(o.site.split(".")[0]);
  const jsons = [...referenced].map(entryJson).filter(Boolean);

  const card = [
    `<Card${attr("id", `card-p2-${token.id}`)}${attr(
      "heading",
      `P2-${token.id} · ${token.token} → ${token.target ?? token.verdict}`,
    )}${attr("tone", tone)}${attr("badge", token.verdict)}${attr("meta", meta)}>`,
    ``,
    prose(token.note),
    ``,
    `<FieldDiff${attr("title", `${token.token} — ${token.occurrences} occurrence(s)`)}${attr(
      "beforeLabel",
      "Current (production)",
    )}${attr("afterLabel", "Proposed")}${attr("fields", fields)} />`,
    ``,
    `<Details${attr("summary", `Full production entries — ${[...referenced].join(", ")}`)}>`,
    ``,
    ...jsons.flatMap((j) => [j, ``]),
    `</Details>`,
    ``,
    `<ReviewChoice${attr("itemId", `pack2-${token.token}`)}${attr(
      "label",
      `${token.token} → ${token.target ?? token.verdict}`.slice(0, 120),
    )} />`,
    ``,
    `</Card>`,
  ].join("\n");
  push(card);
}

/* ------------------------------ T-5 ruling -------------------------------- */

const t5 = titles.items.find((i) => i.id === "T-5");
push(`## Contested title`);
{
  const referenced = new Set([t5.owner]);
  // Include a couple of real neighbours the ruling reasons against.
  for (const id of ["guarantee_and_indemnity", "lease_rules", "building_users_guide"]) {
    if (entryById.has(id)) referenced.add(id);
  }
  const jsons = [...referenced].map(entryJson).filter(Boolean);
  const card = [
    `<Card${attr("id", "card-t5")}${attr(
      "heading",
      `T-5 · ${t5.contested_title} → ${t5.owner}`,
    )}${attr("tone", "success")}${attr("badge", t5.verdict)}${attr("meta", [
      `confidence: ${t5.confidence}`,
      "title ruling",
    ])}>`,
    ``,
    prose(t5.rule),
    ``,
    prose(`**Why.** ${t5.rationale}`),
    ``,
    prose(`**Charitable alternatives tested.** ${t5.charitable}`),
    ``,
    `<Details summary="Cited report evidence">`,
    ``,
    `<Json${attr("title", "T-5 evidence excerpts")}${attr(
      "json",
      JSON.stringify(t5.evidence, null, 2),
    )} collapsedDepth={2} />`,
    ``,
    `</Details>`,
    ``,
    `<Details${attr("summary", `Full production entries — ${[...referenced].join(", ")}`)}>`,
    ``,
    ...jsons.flatMap((j) => [j, ``]),
    `</Details>`,
    ``,
    `<ReviewChoice${attr("itemId", "title-T-5")}${attr(
      "label",
      `${t5.contested_title} → ${t5.owner}`.slice(0, 120),
    )} />`,
    ``,
    `</Card>`,
  ].join("\n");
  push(card);
}

/* ------------- appendix: real family neighbours to cross 1 MiB ------------ */

const embedded = new Set();
for (const token of pack.tokens) {
  if (entryById.has(token.target)) embedded.add(token.target);
  for (const o of token.occ) embedded.add(o.site.split(".")[0]);
}
embedded.add(t5.owner);

const appendix = [];
for (const entry of production) {
  if (bytes() + Buffer.byteLength(appendix.join("\n\n"), "utf8") > TARGET_MIB) break;
  if (embedded.has(entry.type_id)) continue;
  embedded.add(entry.type_id);
  appendix.push(
    `<Details${attr("summary", `${entry.type_id} — ${entry.type_name}`)}>\n\n${entryJson(
      entry.type_id,
    )}\n\n</Details>`,
  );
}
if (appendix.length) {
  push(`## Family context (full production entries)`);
  push(
    `The remaining production taxonomy entries the pack reasons against, embedded in full for a ` +
      `self-contained review. ${appendix.length} entries.`,
  );
  for (const a of appendix) push(a);
}

/* ------------------------------ open questions ---------------------------- */

push(
  `## Open questions\n\n<QuestionForm${attr("questions", [
    {
      id: "rollout",
      title: "Apply accepted pack-2 redirects in one batch or stage by confidence?",
      mode: "single",
      options: [
        {
          id: "batch",
          label: "One batch",
          detail: "All accepted redirects/rewrites ship together.",
          recommended: true,
        },
        {
          id: "stage",
          label: "Stage near-certain first",
          detail: "Lineage-backed redirects first, then the high-confidence rewrites.",
        },
      ],
    },
  ])} />`,
);

process.stdout.write(out.join("\n\n") + "\n");
process.stderr.write(`generated ${(bytes() / 1024 / 1024).toFixed(2)} MiB\n`);
