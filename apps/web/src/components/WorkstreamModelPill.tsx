import type { ModelSelection } from "@t3tools/contracts";

import { getProviderModelParts, getProviderTint } from "../lib/workstreamPresentation";

/**
 * Shared provider + model pill (plan §2.2): `{provider} · {model}` with a
 * per-provider tint dot. The same model on a different provider is materially
 * different, so the tint carries the provider at a glance. Border/background are
 * derived from the tint at low alpha via inline hex+alpha suffixes (avoids
 * `color-mix` support questions and an arbitrary-class explosion for dynamic
 * colours). Consumed by the hover card and the active strip.
 */
export function WorkstreamModelPill({ selection }: { selection: ModelSelection }) {
  const { provider, model } = getProviderModelParts(selection);
  const tint = getProviderTint(provider);
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full py-[1.5px] pl-1.5 pr-2 font-mono text-[9.5px] text-white/[0.78]"
      style={{ border: `1px solid ${tint}66`, background: `${tint}1c` }}
    >
      <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: tint }} />
      <span className="text-white/55">{provider}</span>
      <span aria-hidden>·</span>
      <span>{model}</span>
    </span>
  );
}
