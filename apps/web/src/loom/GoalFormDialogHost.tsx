/**
 * loom: the one mounted renderer for `promptGoalForm` (3d-3). Mounted once by
 * the sidebar so goal rename can be driven from the thread context menu
 * without any menu owning dialog state.
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

import { useGoalFormDialogStore } from "./goalFormDialogStore";

export function GoalFormDialogHost() {
  const request = useGoalFormDialogStore((state) => state.request);
  const resolveGoalForm = useGoalFormDialogStore((state) => state.resolveGoalForm);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  // Re-seed on each new request; the drafts are deliberately request-local.
  useEffect(() => {
    if (!request) return;
    setTitle(request.initial.title);
    setDescription(request.initial.description);
  }, [request]);

  const canSubmit = title.trim().length > 0;
  const submit = () => {
    if (canSubmit) resolveGoalForm({ title: title.trim(), description: description.trim() });
  };

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) resolveGoalForm(null);
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Rename goal</DialogTitle>
          <DialogDescription>
            The title and paragraph shown wherever this Loom goal appears.
          </DialogDescription>
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
          <Button type="button" variant="outline" size="sm" onClick={() => resolveGoalForm(null)}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={!canSubmit} onClick={submit}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
