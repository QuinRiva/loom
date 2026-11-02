// loom: the "Model: A → B" timeline divider (rows derived in ./modelChangeRows.ts).
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { CpuIcon } from "lucide-react";
import { memo, use } from "react";

import { TimelineRowCtx } from "~/components/chat/timelineRowContext";
import { getTriggerDisplayModelName } from "~/components/chat/providerIconUtils";
import { TimelineSystemDivider } from "~/components/chat/TimelineSystemDivider";
import { deriveProviderInstanceEntries } from "~/providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "~/state/server";

import type { LoomModelChangeRow } from "./modelChangeRows";

// A timeline fed by its own turn-item source (the guest view) has no environment to ask.
const NO_PROVIDERS = Atom.make(EMPTY_SERVER_PROVIDERS).pipe(
  Atom.withLabel("loom-model-change-divider:no-providers"),
);

export const ModelChangeDivider = memo(function ModelChangeDivider({
  row,
}: {
  row: LoomModelChangeRow;
}) {
  const { activeThreadEnvironmentId, turnItemSource } = use(TimelineRowCtx);
  // Selects the label string, so a provider status push (fresh `checkedAt`)
  // re-renders the divider only when a model name changed.
  const detail = useAtomValue(
    turnItemSource === undefined
      ? serverEnvironment.providersValueAtom(activeThreadEnvironmentId)
      : NO_PROVIDERS,
    (providers) => {
      const entry = deriveProviderInstanceEntries(providers ?? EMPTY_SERVER_PROVIDERS).find(
        (candidate) => candidate.instanceId === row.instanceId,
      );
      const name = (slug: string) => {
        const model = entry?.models.find((candidate) => candidate.slug === slug);
        return model === undefined ? slug : getTriggerDisplayModelName(model, entry?.driverKind);
      };
      return `${name(row.fromModel)} → ${name(row.toModel)}`;
    },
  );
  return <TimelineSystemDivider label="Model" detail={detail} icon={CpuIcon} />;
});
