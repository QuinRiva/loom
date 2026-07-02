<!-- GENERATED FILE — do not edit by hand.
     Source of truth: the zod `schema` exports in
     apps/web/src/components/files/mdx-plan/blocks/*.tsx (+ registry.tsx).
     Regenerate: UPDATE_BLOCK_SCHEMA=1 pnpm --filter @t3tools/web test run blockSchemaDoc
     The drift test blockSchemaDoc.test.ts fails CI if this file and the schemas disagree. -->

# MDX plan block schema reference

Authoritative prop shapes for every plan block, generated from the live zod
schemas. **Do not guess props or enum values — consult this file.** Every prop
lists its type, whether it is required or optional, allowed enum values, and any
nested object/array sub-shape. Unlisted props are rejected by validation.

## Encoding recap

- String → `attr="value"` (or `attr={"…\n…"}` for multi-line / special chars).
- Number → `attr={12}`; boolean true → bare `attr` (omit for false).
- Array / object → a JSON literal in braces with double-quoted keys, e.g.
  `entities={[{ "id": "user", "name": "User", "fields": [] }]}`.
- No free `{expressions}` in the body or as attribute values — literal data only.

## Gotchas that have bitten authors

- `<DataModel>` field `fk` is a **string FK target** (e.g. `"Value.value_id"`),
  NOT a boolean. `fk: true` is invalid.
- `<DataModel>` relation `kind` is one of `"1-1" | "1-n" | "n-n"` — there is
  **no `"n-1"`**. Model many-to-one as `"1-n"` with `from`/`to` flipped (from
  the "one" side to the "many" side).
- Enum props accept only the listed values; anything else fails validation and
  the block renders an error card instead of the block.

## `<Code>` — `code`

Props:

- `code` — `string` **(required)**
- `language` — `string` _(optional)_
- `filename` — `string` _(optional)_
- `caption` — `string` _(optional)_
- `maxLines` — `integer` _(optional)_

## `<DataModel>` — `data-model`

Props:

- `entities` — `object[]` **(required)**
  - `id` — `string` **(required)**
  - `name` — `string` **(required)**
  - `note` — `string` _(optional)_
  - `change` — `"added" | "modified" | "removed" | "renamed"` _(optional)_
  - `fields` — `object[]` **(required)**
    - `name` — `string` **(required)**
    - `type` — `string` _(optional)_
    - `pk` — `boolean` _(optional)_
    - `fk` — `string` _(optional)_
    - `nullable` — `boolean` _(optional)_
    - `default` — `string` _(optional)_
    - `note` — `string` _(optional)_
    - `change` — `"added" | "modified" | "removed" | "renamed"` _(optional)_
    - `was` — `string` _(optional)_
- `relations` — `object[]` _(optional)_
  - `from` — `string` **(required)**
  - `to` — `string` **(required)**
  - `kind` — `"1-1" | "1-n" | "n-n"` _(optional)_
  - `label` — `string` _(optional)_

## `<Endpoint>` — `api-endpoint`

Props:

- `method` — `"GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"` **(required)**
- `path` — `string` **(required)**
- `summary` — `string` _(optional)_
- `description` — `string` _(optional)_ — written as **prose between the tags**, not an attribute
- `auth` — `string` _(optional)_
- `deprecated` — `boolean` _(optional)_
- `change` — `"added" | "modified" | "removed" | "renamed"` _(optional)_
- `params` — `object[]` _(optional)_
  - `name` — `string` **(required)**
  - `in` — `"path" | "query" | "header" | "body"` **(required)**
  - `type` — `string` _(optional)_
  - `required` — `boolean` _(optional)_
  - `description` — `string` _(optional)_
  - `change` — `"added" | "modified" | "removed" | "renamed"` _(optional)_
  - `was` — `string` _(optional)_
- `request` — `object` _(optional)_
  - `contentType` — `string` _(optional)_
  - `example` — `string` _(optional)_
- `responses` — `object[]` _(optional)_
  - `status` — `string` **(required)**
  - `description` — `string` _(optional)_
  - `example` — `string` _(optional)_
  - `change` — `"added" | "modified" | "removed" | "renamed"` _(optional)_

## `<FileTree>` — `file-tree`

Props:

- `title` — `string` _(optional)_
- `entries` — `object[]` **(required)**
  - `path` — `string` **(required)**
  - `change` — `"added" | "modified" | "removed" | "renamed"` _(optional)_
  - `note` — `string` _(optional)_
  - `snippet` — `string` _(optional)_
  - `language` — `string` _(optional)_

## `<AnnotatedCode>` — `annotated-code`

Props:

- `code` — `string` **(required)**
- `language` — `string` _(optional)_
- `filename` — `string` _(optional)_
- `annotations` — `object[]` **(required)**
  - `lines` — `string` **(required)**
  - `label` — `string` _(optional)_
  - `note` — `string` **(required)**

## `<Diagram>` — `diagram`

Props:

- `caption` — `string` _(optional)_
- `nodes` — `object[]` _(optional)_
  - `id` — `string` **(required)**
  - `label` — `string` **(required)**
  - `detail` — `string` _(optional)_
  - `x` — `number` _(optional)_
  - `y` — `number` _(optional)_
- `edges` — `object[]` _(optional)_
  - `from` — `string` **(required)**
  - `to` — `string` **(required)**
  - `label` — `string` _(optional)_
- `notes` — `object[]` _(optional)_
  - `id` — `string` **(required)**
  - `text` — `string` **(required)**
  - `x` — `number` _(optional)_
  - `y` — `number` _(optional)_

## `<QuestionForm>` — `question-form`

Props:

- `questions` — `object[]` **(required)**
  - `id` — `string` **(required)**
  - `title` — `string` **(required)**
  - `subtitle` — `string` _(optional)_
  - `mode` — `"single" | "multi" | "freeform"` **(required)**
  - `options` — `object[]` _(optional)_
    - `id` — `string` **(required)**
    - `label` — `string` **(required)**
    - `detail` — `string` _(optional)_
    - `recommended` — `boolean` _(optional)_
  - `allowOther` — `boolean` _(optional)_
  - `placeholder` — `string` _(optional)_
  - `required` — `boolean` _(optional)_
- `submitLabel` — `string` _(optional)_

## `<Json>` — `json-explorer`

Props:

- `title` — `string` _(optional)_
- `json` — `string` **(required)**
- `collapsedDepth` — `integer` _(optional)_

## `<Callout>` — `callout`

Props:

- `tone` — `"info" | "decision" | "risk" | "warning" | "success"` _(optional)_
- `body` — `string` _(optional)_ — written as **prose between the tags**, not an attribute

## `<Checklist>` — `checklist`

Props:

- `items` — `object[]` **(required)**
  - `id` — `string` **(required)**
  - `label` — `string` **(required)**
  - `checked` — `boolean` _(optional)_
  - `note` — `string` _(optional)_

## `<Table>` — `table`

Props:

- `columns` — `string[]` **(required)**
- `rows` — `string[][]` **(required)**
- `density` — `"compact" | "normal" | "relaxed"` _(optional)_

## `<VisualQuestions>` — `visual-questions`

Props:

- `questions` — `object[]` **(required)**
  - `id` — `string` **(required)**
  - `title` — `string` **(required)**
  - `subtitle` — `string` _(optional)_
  - `mode` — `"single" | "multi" | "freeform"` **(required)**
  - `options` — `object[]` _(optional)_
    - `id` — `string` **(required)**
    - `label` — `string` **(required)**
    - `detail` — `string` _(optional)_
    - `recommended` — `boolean` _(optional)_
  - `allowOther` — `boolean` _(optional)_
  - `placeholder` — `string` _(optional)_
  - `required` — `boolean` _(optional)_
- `submitLabel` — `string` _(optional)_

## `<Diff>` — `diff`

Props:

- `filename` — `string` _(optional)_
- `language` — `string` _(optional)_
- `before` — `string` **(required)**
- `after` — `string` **(required)**
- `mode` — `"unified" | "split"` _(optional)_
- `annotations` — `object[]` _(optional)_
  - `side` — `"before" | "after"` _(optional)_
  - `lines` — `string` **(required)**
  - `label` — `string` _(optional)_
  - `note` — `string` **(required)**

## `<OpenApi>` — `openapi-spec`

Props:

- `spec` — `string` **(required)**
- `title` — `string` _(optional)_

## `<Mermaid>` — `mermaid`

Props:

- `source` — `string` **(required)**
- `caption` — `string` _(optional)_

## `<Screen>` — `wireframe`

Props:

- `surface` — `"browser" | "desktop" | "mobile" | "popover" | "panel"` _(optional)_ default `"browser"`
- `html` — `string` **(required)**
- `caption` — `string` _(optional)_

## `<Design>` — `design`

Props:

- `surface` — `"browser" | "desktop" | "mobile" | "popover" | "panel"` _(optional)_ default `"browser"`
- `html` — `string` **(required)**
- `caption` — `string` _(optional)_

## `<DesignBoard>` — `canvas`

Container block: renders nested plan blocks written **between its tags** as children.

Props:

- `title` — `string` _(optional)_
- `width` — `number` _(optional)_
- `height` — `number` _(optional)_

## `<Section>` — `canvas-section`

Container block: renders nested plan blocks written **between its tags** as children.

Props:

- `title` — `string` _(optional)_
- `x` — `number` **(required)**
- `y` — `number` **(required)**
- `width` — `number` **(required)**
- `height` — `number` **(required)**

## `<Artboard>` — `wireframe`

Props:

- `x` — `number` **(required)**
- `y` — `number` **(required)**
- `surface` — `"browser" | "desktop" | "mobile" | "popover" | "panel"` _(optional)_ default `"browser"`
- `html` — `string` **(required)**
- `caption` — `string` _(optional)_
- `fidelity` — `"wireframe" | "design"` _(optional)_

## `<Annotation>` — `annotation`

Props:

- `targetId` — `string` _(optional)_
- `placement` — `"left" | "right" | "top" | "bottom"` _(optional)_
- `x` — `number` _(optional)_
- `y` — `number` _(optional)_
- `text` — `string` _(optional)_ — written as **prose between the tags**, not an attribute

## `<Connector>` — `canvas-connector`

Props:

- `from` — `string` **(required)**
- `to` — `string` **(required)**
- `label` — `string` _(optional)_

## `<Columns>` — `columns`

Container block: renders nested plan blocks written **between its tags** as children.

_No attributes._

## `<Column>` — `column`

Container block: renders nested plan blocks written **between its tags** as children.

Props:

- `label` — `string` _(optional)_

## `<TabsBlock>` — `tabs`

Container block: renders nested plan blocks written **between its tags** as children.

Props:

- `orientation` — `"horizontal" | "vertical"` _(optional)_

## `<Tab>` — `tab`

Container block: renders nested plan blocks written **between its tags** as children.

Props:

- `label` — `string` _(optional)_

## `<Prototype>` — `prototype`

Props:

- `html` — `string` **(required)**
- `caption` — `string` _(optional)_
- `height` — `integer` _(optional)_

## `<HtmlBlock>` — `html`

Props:

- `html` — `string` **(required)**
- `caption` — `string` _(optional)_
- `height` — `integer` _(optional)_
