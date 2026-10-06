/**
 * loom: the one mounted renderer for `promptGoalForm` (3d-3). Mounted once by
 * the sidebar so goal rename can be driven from the thread context menu
 * without any menu owning dialog state.
 */
import { useState } from "react";

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

import { type GoalFormValues, useGoalFormDialogStore } from "./goalFormDialogStore";

export function GoalFormDialogHost() {
  const request = useGoalFormDialogStore((state) => state.request);
  const resolveGoalForm = useGoalFormDialogStore((state) => state.resolveGoalForm);
  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) resolveGoalForm(null);
      }}
    >
      <DialogPopup>
        {request ? (
          // Keyed per request: the drafts are deliberately request-local.
          <GoalForm key={request.id} initial={request.initial} onResolve={resolveGoalForm} />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function GoalForm({
  initial,
  onResolve,
}: {
  initial: GoalFormValues;
  onResolve: (values: GoalFormValues | null) => void;
}) {
  const [title, setTitle] = useState(initial.title);
  const [description, setDescription] = useState(initial.description);
  const canSubmit = title.trim().length > 0;
  const submit = () => {
    if (canSubmit) onResolve({ title: title.trim(), description: description.trim() });
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>Rename goal</DialogTitle>
        <DialogDescription>The title and paragraph shown wherever this Loom goal appears.</DialogDescription>
      </DialogHeader>
      <DialogPanel>
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
          />
        </label>
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
        <Button type="button" variant="outline" size="sm" onClick={() => onResolve(null)}>
          Cancel
        </Button>
        <Button type="button" size="sm" disabled={!canSubmit} onClick={submit}>
          Save
        </Button>
      </DialogFooter>
    </>
  );
}
