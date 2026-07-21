import type { ModelSelection } from "@t3tools/contracts";

import { getProviderModelParts, getProviderTint } from "../lib/workstreamPresentation";

/**
 * Shared provider + model pill (plan §2.2): `{provider} · {model}` with a
 * per-provider tint dot. The provider is parsed from the model slug prefix
 * (`cliproxy`, `google-vertex-claude`, …) — the same model on a different
 * provider is materially different, so the tint carries it at a glance. A slug
 * with no prefix shows just the model (no provider segment). Border/background
 * are derived from the tint at low alpha via inline hex+alpha suffixes (avoids
 * `color-mix` support questions and an arbitrary-class explosion for dynamic
 * colours). Consumed by the hover card and the active strip.
 *
 * Width-safe: the pill never exceeds its container (`max-w-full`), and when
 * space is tight the PROVIDER truncates while the MODEL stays whole — the model
 * version (opus-4-8 vs -4-7) is the discriminator the user must always see.
 */
export function WorkstreamModelPill({ selection }: { selection: ModelSelection }) {
  const { provider, model } = getProviderModelParts(selection);
  const tint = getProviderTint(provider ?? model);
  return (
    <span
      className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full py-[1.5px] pl-1.5 pr-2 font-mono text-[9.5px] text-white/[0.78]"
      style={{ border: `1px solid ${tint}66`, background: `${tint}1c` }}
      title={provider ? `${provider} · ${model}` : model}
    >
      <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: tint }} />
      {provider ? (
        <>
          <span className="min-w-0 truncate text-white/55">{provider}</span>
          <span aria-hidden className="shrink-0 text-white/30">
            ·
          </span>
        </>
      ) : null}
      <span className="shrink-0">{model}</span>
    </span>
  );
}
