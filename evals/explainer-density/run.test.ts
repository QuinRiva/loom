import { describe, expect, it } from "vite-plus/test";
import { grade } from "./grade.ts";

const dense = `### 3.2 A margin with no unit

The agreement charges 2 points over the cash rate (\`S12:supply_agreement/8/2\`). Gold records value 2, unit \`pp_over_reference\` and reference \`cash_rate\`; the definition says a margin is points over a reference, and the contract allows \`rule\`, \`value\`, \`unit\` and \`reference\`, so the model's "percent" and "cash rate" fail on the keys gold states even though the value matches exactly. Had it written percentage points it would have met the same undeclared unit word as the late-fee cap row in section 4.2, so the miss is half the model's and half the ask's. The payment terms row next door, net 30 days from the invoice date under clause 8.1 of the same agreement, scored correct on every key.
`;

const shapeD = `<Card eyebrow="3.2" heading="A margin with no unit">

**Verdict: marked wrong.** <Badge tone="warning">half the model's</Badge>

<Table columns={["Who", "What", "Where"]} rows={[["Gold", "2, \`pp_over_reference\`", "Workbook row 41"]]} />

**Why it is marked wrong.** Every key gold fills must match. <Sidenote>Scorer §4.1 (\`S12:x\`).</Sidenote>

**Whose miss.** Half the model's. Half the ask's, e.g. the unit word.

</Card>
`;

describe("grade", () => {
  it("scores the dense paragraph as dense and shapeless", () => {
    expect(grade(dense)).toMatchObject({
      sentences: 4,
      longSentences: 2,
      longParagraphs: 1,
      bracketedCitations: 1,
      verdict: false,
      table: false,
      labelled: false,
    });
  });

  it("scores the shape-D unit as short, with all three parts and the note out of the prose", () => {
    const result = grade(shapeD);
    expect(result).toMatchObject({
      sentences: 7,
      longSentences: 0,
      longParagraphs: 0,
      bracketedCitations: 0,
      sidenotes: 1,
      verdict: true,
      table: true,
      labelled: true,
    });
    expect(result.meanSentence).toBeCloseTo(29 / 7);
  });
});
