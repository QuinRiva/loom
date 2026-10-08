// loom: the "Model: A → B" timeline divider (rows derived in ./modelChangeRows.ts).
import { CpuIcon } from "lucide-react";
import { memo, use } from "react";

import { TimelineRowCtx } from "~/components/chat/MessagesTimeline";
import { getTriggerDisplayModelName } from "~/components/chat/providerIconUtils";
import { TimelineSystemDivider } from "~/components/chat/TimelineSystemDivider";
import { getProviderInstanceEntry } from "~/providerInstances";

import type { LoomModelChangeRow } from "./modelChangeRows";

export const ModelChangeDivider = memo(function ModelChangeDivider({
  row,
}: {
  row: LoomModelChangeRow;
}) {
  const providers = use(TimelineRowCtx).providerStatuses;
  const models = getProviderInstanceEntry(providers, row.instanceId)?.models ?? [];
  const name = (slug: string) => {
    const model = models.find((candidate) => candidate.slug === slug);
    return model === undefined ? slug : getTriggerDisplayModelName(model);
  };
  return (
    <TimelineSystemDivider
      label="Model"
      detail={`${name(row.fromModel)} → ${name(row.toModel)}`}
      icon={CpuIcon}
    />
  );
});
