/**
 * Fact packs an agent turns into one section of an explainer. Each pack is invented, in the shape
 * of a real paragraph that read as dense: nine facts from three parties, a counterfactual and a
 * neighbouring row, each with a source an author is tempted to cite inside the sentence.
 */
export type Case = {
  readonly id: string;
  readonly source: string;
  readonly prompt: string;
};

export const cases: ReadonlyArray<Case> = [
  {
    id: "interest-margin-unit",
    source:
      "Invented; mirrors the specimen in explainers/fact-dense-explanation/explainer.mdx (extraction-misses §3.3, a field marked wrong on a unit word the model was never shown).",
    prompt: `You are writing \`explainers/contract-extraction-misses/explainer.mdx\` for Carl, the maintainer. It explains why rows in yesterday's contract-extraction run were marked wrong. Sections 1, 2 and 3.1 are written. Write section 3.2 from your investigation notes below, as it will appear in the document. Reply with the MDX for that section only.

Investigation notes for row 41, field \`late_payment_interest\`, in the Harbour Supplies supply agreement:

1. The agreement, clause 8.2 (node \`S12:supply_agreement/8/2\`): overdue invoices bear interest at 2 percentage points above the central bank's cash rate, accruing daily from the due date.
2. The field definition, sent to the model: a margin over a reference rate is recorded as a number of percentage points plus the reference it sits over. "2% above the cash rate" means a value of 2 over the cash rate, not an absolute rate of 2%.
3. The output contract, sent to the model: four keys are allowed, \`rule\`, \`value\`, \`unit\` and \`reference\`.
4. Gold (the human annotator's answer, gold workbook row 41): \`value\` 2, \`unit\` \`pp_over_reference\`, \`reference\` \`cash_rate\`. \`rule\` left empty.
5. The model's answer (run r-0193): \`value\` 2, \`unit\` "percent", \`reference\` "cash rate", and the clause copied into \`rule\`.
6. The scoring rule (scorer documentation §4.1): an answer passes only if every key gold fills matches; strings are compared letter for letter after lower-casing. Keys gold leaves empty are ignored.
7. Result: the row fails on \`unit\` ("percent" against \`pp_over_reference\`) and on \`reference\` ("cash rate" against \`cash_rate\`). \`value\` matches.
8. Counterfactual: had the model written "percentage points", it would still have failed. Gold's unit word \`pp_over_reference\` appears in neither the definition nor the contract, and no example shows the underscore form of the reference. The late-fee cap row on the same agreement fails on the same unit word (section 4.2).
9. Neighbouring row: \`payment_terms\` on the same agreement (net 30 days from the invoice date, clause 8.1) scored correct.

My reading: half the model's miss, since the definition says percentage points and it wrote "percent"; half the ask's, since even the right words would fail on a unit and reference form the model was never shown.`,
  },
];
