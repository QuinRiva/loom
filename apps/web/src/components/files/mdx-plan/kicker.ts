import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * The frontmatter `kicker:` — the small line above the title that says what the
 * document is (genre, subject, date, the PR), so the title can say what it
 * found. A remark plugin, not a guard: it reads the leading `yaml` node that
 * `remarkFrontmatter` parsed (the same YAML decode the reader-brief lint uses)
 * and inserts a `p.plan-kicker` right after it. An absent, empty or non-string
 * kicker inserts nothing.
 */

type MdastNode = { type: string; value?: string; children?: MdastNode[]; data?: unknown };

const decodeKicker = Schema.decodeUnknownOption(fromYaml(Schema.Struct({ kicker: Schema.String })));

export const remarkKicker = () => (tree: MdastNode) => {
  const children = tree.children ?? [];
  const yaml = children[0]?.type === "yaml" ? children[0] : undefined;
  const kicker = Option.getOrUndefined(decodeKicker(yaml?.value ?? ""))?.kicker.trim();
  if (!kicker) return;
  children.splice(1, 0, {
    type: "paragraph",
    data: { hProperties: { className: "plan-kicker" } },
    children: [{ type: "text", value: kicker }],
  });
};
