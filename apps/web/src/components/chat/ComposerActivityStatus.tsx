import type { ScopedThreadRef } from "@t3tools/contracts";

import { Spinner } from "~/components/ui/spinner";

import { useThreadSyncError } from "../../state/entities";
import { threadSyncLabel, type ThreadSyncPhase } from "../../threadSync";
import { ComposerBanner } from "./ComposerBanner";

export function ComposerActivityRow({
  phase,
  // loom: the thread whose detail subscription this row reports on.
  threadRef,
}: {
  readonly phase: ThreadSyncPhase;
  readonly threadRef: ScopedThreadRef;
}) {
  // loom: upstream's phase has no error arm, so a detail subscription that
  // failed renders an indefinite "Loading messages..." with no reason. The
  // phase cannot carry the distinction — the same atom is set both by a
  // failure that retries 250ms later and by one that parks — so surface the
  // diagnostic beside the label rather than claiming the load is terminal.
  const syncError = useThreadSyncError(threadRef);
  return (
    <ComposerBanner.Row>
      <ComposerBanner.Icon>
        <Spinner />
      </ComposerBanner.Icon>
      <ComposerBanner.Content>
        <span
          className="shrink-0 whitespace-nowrap text-muted-foreground"
          data-composer-sync-status={phase}
          role="status"
        >
          {threadSyncLabel(phase)}
        </span>
        {/* loom: the failed attempt's diagnostic, so the spinner is not the only signal. */}
        {syncError === null ? null : (
          <span className="min-w-0 truncate text-muted-foreground/70">{syncError}</span>
        )}
      </ComposerBanner.Content>
    </ComposerBanner.Row>
  );
}
