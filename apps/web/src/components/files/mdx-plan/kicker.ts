import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Remark plugin that inserts the frontmatter `kicker:` (what the document is) as a
 * `p.plan-kicker` after the leading `yaml` node. An absent, empty or non-string
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
