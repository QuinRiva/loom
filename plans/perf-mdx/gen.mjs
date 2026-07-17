// Synthetic tier-(b) decision-doc MDX generator for perf measurement.
// Usage: node gen.mjs <targetMB> > out.mdx
// Shape: dozens of <Card> items, each with prose + <FieldDiff> + <Details>(<Json>) + <ReviewChoice>,
// plus a few large <Table>s. The bulk lives in the tens-of-KB JSON strings inside collapsed <Details>.

const targetMB = parseFloat(process.argv[2] ?? "1");
const targetBytes = targetMB * 1024 * 1024;

// Deterministic pseudo-random so runs are comparable.
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const WORDS =
  "lease tenant landlord premises rent commencement expiry option renewal covenant indemnity clause schedule annexure obligation liability assignment sublet outgoings review market ratchet turnover percentage guarantee bond security deposit make good reinstatement fixtures fittings services levy".split(
    " ",
  );
const sentence = (n = 18) =>
  Array.from({ length: n }, () => pick(WORDS)).join(" ").replace(/^./, (c) => c.toUpperCase()) + ".";
const prose = (paras = 2) =>
  Array.from({ length: paras }, () => sentence(14 + Math.floor(rnd() * 20))).join("\n\n");

// A tens-of-KB JSON evidence record (this is where document bulk accumulates).
function evidenceJson(approxKB) {
  const rows = Math.max(4, Math.round((approxKB * 1024) / 950));
  const record = {
    source_document: `production/lease-${Math.floor(rnd() * 9999)}.pdf`,
    extracted_at: "2026-07-10T04:22:11Z",
    confidence: Number(rnd().toFixed(4)),
    pages: Array.from({ length: rows }, (_, i) => ({
      page: i + 1,
      text_span: sentence(28),
      bbox: [rnd() * 600, rnd() * 800, rnd() * 600, rnd() * 800].map((n) => Number(n.toFixed(2))),
      tokens: sentence(20).split(" "),
      candidates: Array.from({ length: 3 }, () => ({
        field: pick(WORDS),
        value: sentence(6),
        score: Number(rnd().toFixed(4)),
      })),
    })),
  };
  return JSON.stringify(record, null, 2);
}


function card(i, jsonKB) {
  const tone = pick(["neutral", "info", "success", "warning", "risk", "accent"]);
  const json = evidenceJson(jsonKB);
  const before = sentence(5);
  const after = sentence(5);
  return `<Card id="card-${i}" heading="Field ${i}: ${pick(WORDS)} ${pick(WORDS)}" tone="${tone}" badge="${pick(["REVIEW", "AUTO", "FLAGGED"])}" meta={${JSON.stringify([`conf ${rnd().toFixed(2)}`, `page ${i}`])}}>

${prose(2)}

<FieldDiff title="Record ${i}" fields={${JSON.stringify([
    { name: "value", before, after },
    { name: "source", before: "manual", after: "auto" },
    { name: "page", before: String(i), after: String(i), kept: true },
  ])}} />

<Details summary="Extraction evidence (production record, ${jsonKB}KB JSON)">

${prose(1)}

<Json title="raw-extraction-${i}.json" json={${JSON.stringify(json)}} collapsedDepth={2} />

</Details>

<ReviewChoice id="rc-${i}" itemId="rc-${i}" label="Accept extracted ${pick(WORDS)}?" />

</Card>`;
}

function bigTable(cols, rowsN) {
  const columns = Array.from({ length: cols }, (_, c) => `Col ${c + 1}`);
  const rows = Array.from({ length: rowsN }, () =>
    Array.from({ length: cols }, () => pick(WORDS)),
  );
  return `<Table columns={${JSON.stringify(columns)}} rows={${JSON.stringify(rows)}} />`;
}

let out = `# Lease Extraction Review — Synthetic Perf Fixture (~${targetMB} MB)

${prose(2)}

`;
out += bigTable(8, 300) + "\n\n";

let i = 0;
const jsonKB = 16; // tens-of-KB evidence per card => bulk driver
while (Buffer.byteLength(out, "utf8") < targetBytes) {
  out += card(i++, jsonKB) + "\n\n";
  if (i % 40 === 0) out += bigTable(6, 200) + "\n\n"; // a few large tables interspersed
}

process.stderr.write(
  `generated ${(Buffer.byteLength(out, "utf8") / 1024 / 1024).toFixed(2)} MB, ${i} cards\n`,
);
process.stdout.write(out);
