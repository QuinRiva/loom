// loom: the "Model: A → B" timeline divider (rows derived in ./modelChangeRows.ts).
import { useAtomValue } from "@effect/atom-react";
import { CpuIcon } from "lucide-react";
import { memo, use } from "react";

import { TimelineRowCtx } from "~/components/chat/MessagesTimeline";
import { getTriggerDisplayModelName } from "~/components/chat/providerIconUtils";
import { TimelineSystemDivider } from "~/components/chat/TimelineSystemDivider";
import { getProviderInstanceEntry } from "~/providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "~/state/server";

import type { LoomModelChangeRow } from "./modelChangeRows";

export const ModelChangeDivider = memo(function ModelChangeDivider({
  row,
}: {
  row: LoomModelChangeRow;
}) {
  const { activeThreadEnvironmentId } = use(TimelineRowCtx);
  // Selects the label string, so a provider status push (fresh `checkedAt`)
  // re-renders the divider only when a model name changed (upstream #20854).
  const detail = useAtomValue(
    serverEnvironment.providersValueAtom(activeThreadEnvironmentId),
    (providers) => {
      const models =
        getProviderInstanceEntry(providers ?? EMPTY_SERVER_PROVIDERS, row.instanceId)?.models ??
        [];
      const name = (slug: string) => {
        const model = models.find((candidate) => candidate.slug === slug);
        return model === undefined ? slug : getTriggerDisplayModelName(model);
      };
      return `${name(row.fromModel)} → ${name(row.toModel)}`;
    },
  );
  return <TimelineSystemDivider label="Model" detail={detail} icon={CpuIcon} />;
});
