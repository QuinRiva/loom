import { describe, expect, it } from "vite-plus/test";

import { proseDensity } from "./proseDensity";

// The original paragraph and its shape-D rewrite, from
// explainers/fact-dense-explanation/explainer.mdx (first screen and its <Details>).
const SPECIMEN =
  "The licence says the fee after a review must not be less than the fee before it (`F07:car_parking_licence_14_m/3/(c)/(i)`). Gold records the floor as 100% of the passing rent; the field's definition says in terms that \"100% of a specified reference rent equals a 0% minimum increase over that same rent\", and the contract allows `rule`, `unit` and `value`. The model returned the rule sentence and no value or unit, so the row fails on the keys gold states. Had it written the value, it would then have met the same undeclared unit word as the lease's floor and cap (§4.1), so this miss is half the model's and half the ask's. your chat example \"parking review rules\" is this row's neighbour: the review rule itself (linked to the lease's percentage and timing) scored correct.";
const REWRITE = [
  '<Card id="specimen-d" eyebrow="Shape D · recommended" heading="3.3 A floor the definition asks for as a number: the parking licence fee" tone="success">',
  "",
  '**Verdict: marked wrong.** <Badge tone="warning">half the model\'s</Badge> <Badge tone="warning">half the ask\'s</Badge>',
  "",
  "The model wrote the floor as a sentence. Gold and the field definition both want it as a number.",
  "",
  "Gold is the human annotator's answer, which the run is scored against. The model is sent two texts per field: the definition, saying what the field means, and the contract, saying what shape the answer must take.",
  "",
  "<Table",
  '  density="compact"',
  '  columns={["Who", "What they say about the floor", "Where"]}',
  "  rows={[",
  '    ["**The licence**", "\\"The fee after a review must not be less than the fee before it.\\"", "Clause 3(c)(i), `F07:car_parking_licence_14_m/3/(c)/(i)`"],',
  '    ["**The definition**", "A floor like this is a number: \\"100% of a specified reference rent equals a 0% minimum increase over that same rent\\".", "Sent to the model"],',
  '    ["**The contract**", "Three keys are allowed: `rule`, `unit` and `value`.", "Sent to the model"],',
  '    ["**Gold**", "100% of the passing rent, meaning the fee in force before the review. It fills `value` and `unit`.", "Gold workbook"],',
  '    { tone: "risk", cells: ["**The model**", { badge: { label: "wrong", tone: "risk" }, md: "The rule as a sentence. No `value`, no `unit`." }, "The run\'s answer"] },',
  "  ]}",
  "/>",
  "",
  "**Why it is marked wrong.** An answer passes only if every key gold fills in matches. Gold fills `value` and `unit`. The model left both empty.",
  "",
  "**If the model had written the number.** It would still have failed, this time on the unit. Gold's unit is the word `percent_of_passing_rent`, which the scorer compares letter for letter. Nothing the model was shown contains that word. The lease's own review floor and cap fail on the same word (§4.1).",
  "",
  "**Whose miss.** Half the model's: the definition asked for a number and it gave a sentence. Half the ask's, meaning the prompt the model was sent: even the right number would have failed on a word it was never told.",
  "",
  '**The row next door.** Your chat example "parking review rules" is a different field on the same licence. It holds the review rule itself, tied to the lease\'s percentage and timing. It scored correct.',
  "",
  "</Card>",
].join("\n");

const NONE = {
  longParagraphs: [],
  longSentences: [],
  bracketedCitations: [],
  ownLineSidenotes: [],
};

describe("proseDensity", () => {
  it("fires all three density signals on the specimen paragraph", () => {
    expect(proseDensity(SPECIMEN)).toEqual({
      longParagraphs: [{ line: 1, words: 134 }],
      longSentences: [
        { line: 1, words: 40 },
        { line: 1, words: 33 },
      ],
      bracketedCitations: [{ line: 1 }],
      ownLineSidenotes: [],
    });
  });

  it("fires nothing on the shape-D rewrite", () => {
    expect(proseDensity(REWRITE)).toEqual(NONE);
  });

  it("skips the specimen when it is quoted in a blockquote", () => {
    expect(proseDensity(`> ${SPECIMEN}`)).toEqual(NONE);
  });

  it("does not count a plain section reference as a citation", () => {
    expect(proseDensity("The lease's floor and cap fail on the same word (§4.1).")).toEqual(NONE);
  });

  it("does not count a citation inside a <Sidenote>", () => {
    const source =
      "The fee must not fall.<Sidenote>Clause 3(c)(i) (`F07:car_parking_licence_14_m/3/(c)/(i)`)</Sidenote>";
    expect(proseDensity(source)).toEqual(NONE);
  });

  it("flags a <Sidenote> on a line of its own, in its one-line and block forms", () => {
    const source =
      "The fee must not fall.\n\n<Sidenote>Clause 3(c)(i)</Sidenote>\n\n<Sidenote>\nClause 3(c)(i)\n</Sidenote>\n";
    expect(proseDensity(source)).toEqual({ ...NONE, ownLineSidenotes: [{ line: 3 }, { line: 5 }] });
  });
});
