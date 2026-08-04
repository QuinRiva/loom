/**
 * loom: the one mounted renderer for `promptGoalForm` (see goalFormDialogStore).
 * Root-level so goal create/rename can be driven from native context menus and
 * panel overflow menus without any of them owning dialog state — and so no
 * attachment is needed inside upstream's SidebarV2 render tree.
 */
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";

import { slugifyGoalTitle, useGoalFormDialogStore } from "./goalFormDialogStore";

export function GoalFormDialogHost() {
  const request = useGoalFormDialogStore((state) => state.request);
  const resolveGoalForm = useGoalFormDialogStore((state) => state.resolveGoalForm);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugDirty, setSlugDirty] = useState(false);
  const [description, setDescription] = useState("");

  // Re-seed on each new request; the drafts are deliberately request-local.
  useEffect(() => {
    if (!request) return;
    setTitle(request.initial.title);
    setSlug(request.initial.slug);
    setSlugDirty(request.initial.slug.length > 0);
    setDescription(request.initial.description);
  }, [request]);

  const isCreate = request?.mode === "create";
  const effectiveSlug = (slugDirty ? slug : slugifyGoalTitle(title)).trim();
  const canSubmit = title.trim().length > 0 && (!isCreate || effectiveSlug.length > 0);
  const submit = () => {
    if (!canSubmit) return;
    resolveGoalForm({
      title: title.trim(),
      slug: effectiveSlug,
      description: description.trim() || title.trim(),
    });
  };

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) resolveGoalForm(null);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader className="gap-1.5">
          <DialogTitle>{isCreate ? "Create goal from thread" : "Rename goal"}</DialogTitle>
          <DialogDescription>
            {isCreate
              ? "A goal tracks a larger piece of work across the threads that carry it."
              : "The title and paragraph shown wherever this goal appears."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Title</span>
            <Input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                submit();
              }}
              placeholder={"What this goal is trying to achieve\u2026"}
            />
          </label>
          {isCreate ? (
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Slug</span>
              <Input
                value={slugDirty ? slug : slugifyGoalTitle(title)}
                onChange={(event) => {
                  setSlugDirty(true);
                  setSlug(event.target.value);
                }}
                placeholder="short-stable-handle"
              />
            </label>
          ) : null}
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Paragraph</span>
            <Textarea
              size="sm"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={"The objective, and why it matters\u2026"}
            />
          </label>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => resolveGoalForm(null)}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={!canSubmit} onClick={submit}>
            {isCreate ? "Create goal" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
