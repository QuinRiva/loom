import type { ModelSelection } from "@t3tools/contracts";

import { getProviderModelParts, getProviderTint } from "../lib/workstreamPresentation";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * `{provider} · {model}` with a per-provider tint dot (theme tokens, stable per
 * provider slug). When space is tight the provider truncates first, then the
 * model (the full text is in the tooltip), so a long slug never pushes its
 * row's neighbours off a card.
 */
export function WorkstreamModelPill({ selection }: { selection: ModelSelection }) {
  const { provider, model } = getProviderModelParts(selection);
  const tint = getProviderTint(provider ?? model);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border py-px pr-2 pl-1.5 font-mono text-3xs text-foreground/80"
            style={{
              borderColor: `color-mix(in srgb, ${tint} 40%, transparent)`,
              background: `color-mix(in srgb, ${tint} 11%, transparent)`,
            }}
          />
        }
      >
        <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: tint }} />
        {provider ? (
          <>
            <span className="min-w-6 shrink-[99] truncate text-muted-foreground">{provider}</span>
            <span aria-hidden className="shrink-0 text-muted-foreground/70">
              ·
            </span>
          </>
        ) : null}
        <span className="min-w-0 truncate">{model}</span>
      </TooltipTrigger>
      <TooltipPopup>{provider ? `${provider} · ${model}` : model}</TooltipPopup>
    </Tooltip>
  );
}
