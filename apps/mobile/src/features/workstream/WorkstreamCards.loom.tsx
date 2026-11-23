/**
 * loom: the needs-you cards above the lane graph: one per sub-thread waiting on a person, with
 * its one-tap action. Text comes from the shell only; Answer and Review send you to the child.
 */
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { attentionLabel } from "@t3tools/client-runtime/state/loom/rollup";
import {
  formatRelativeAge,
  getRoleLabel,
  type WorkstreamNode,
} from "@t3tools/client-runtime/state/loom/workstreamNodes";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { cn } from "../../lib/cn";
import { useWorkstreamCommands } from "./workstreamCommands.loom";
import { CARD_ACTION_LABELS, cardCopy } from "./workstreamCopy.loom";
import { openReport, openWorkstreamChild } from "./workstreamNavigation.loom";
import type { NeedsYouCard, WorkstreamView } from "./workstreamView.loom";

/** Runs a node command; a failure is an alert. Resolves true on success. */
export async function runWorkstreamCommand(
  failureTitle: string,
  run: () => Promise<AsyncResult.AsyncResult<unknown, unknown>>,
): Promise<boolean> {
  const result = await run();
  if (!AsyncResult.isFailure(result)) return true;
  const cause = squashAtomCommandFailure(result);
  Dialog.alert(failureTitle, cause instanceof Error ? cause.message : "Try again.");
  return false;
}

type PillTone = "accept" | "primary" | "plain" | "danger";

const PILL_CLASSES = {
  accept: ["bg-warning-foreground", "text-screen"],
  primary: ["bg-primary", "text-primary-foreground"],
  plain: ["border border-border bg-transparent", "text-foreground"],
  danger: ["border border-danger-border bg-transparent", "text-danger-foreground"],
} satisfies Record<PillTone, [string, string]>;

export function PillButton(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly tone?: PillTone;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly accessibilityLabel?: string;
  readonly grow?: boolean;
}) {
  const [container, text] = PILL_CLASSES[props.tone ?? "plain"];
  const disabled = Boolean(props.disabled || props.busy);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={{ disabled, busy: Boolean(props.busy) }}
      disabled={disabled}
      onPress={props.onPress}
      hitSlop={4}
      className={cn(
        "min-h-9 flex-row items-center justify-center gap-1.5 rounded-full px-3.5 active:opacity-70",
        container,
        props.grow && "flex-1",
        disabled && "opacity-50",
      )}
    >
      {props.busy ? <AppActivityIndicator colorClassName="accent-foreground-muted" /> : null}
      <Text className={cn("text-[13px] font-t3-bold", text)} numberOfLines={1}>
        {props.label}
      </Text>
    </Pressable>
  );
}

function NeedsYouCardView(props: {
  readonly environmentId: EnvironmentId;
  readonly card: NeedsYouCard;
  readonly node: WorkstreamNode;
  readonly now: number;
  readonly split: boolean;
  readonly canOperate: boolean;
  readonly onAccept: (threadId: ThreadId) => Promise<boolean>;
  readonly onOpenSheet: (threadId: ThreadId) => void;
}) {
  const { card, node } = props;
  // Accept stays busy until the shell confirms: any change to this node ends it.
  const [acceptingNode, setAcceptingNode] = useState<WorkstreamNode | null>(null);
  const error = card.reason === "error";
  const open = () => openWorkstreamChild(props.environmentId, node.id, { split: props.split });
  const accept = async () => {
    setAcceptingNode(node);
    if (!(await props.onAccept(node.id))) setAcceptingNode(null);
  };
  // An accept card's detail already reads "awaiting your acceptance".
  const flag = card.reason && card.kind !== "accept" ? attentionLabel(card.reason) : null;
  const question = card.kind === "answer" ? card.question : null;
  const detail = question
    ? `asked ${formatRelativeAge(question.since, props.now)}`
    : cardCopy(card, node, props.now).detail;
  return (
    <View
      className={cn(
        "gap-2 rounded-2xl border p-3.5",
        error ? "border-danger-border bg-danger" : "border-warning-border bg-warning",
      )}
    >
      <Text className="text-base font-t3-bold" numberOfLines={2}>
        {node.title}
      </Text>
      <Text className="text-xs text-foreground-muted">
        {getRoleLabel(node)}
        {flag ? " · " : null}
        {flag ? (
          <Text
            className={cn(
              "text-xs font-t3-bold",
              error ? "text-danger-foreground" : "text-warning-foreground",
            )}
          >
            {flag}
          </Text>
        ) : null}
        {detail ? ` · ${detail}` : null}
      </Text>
      {question?.title ? (
        <View className="rounded-md border-l-2 border-warning-foreground bg-subtle px-2.5 py-2">
          <Text className="text-sm" numberOfLines={3}>
            {question.title}
          </Text>
        </View>
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        {card.kind === "accept" ? (
          <PillButton
            label={CARD_ACTION_LABELS.accept}
            tone="accept"
            disabled={!props.canOperate}
            busy={acceptingNode === node}
            onPress={() => void accept()}
          />
        ) : (
          <PillButton
            label={CARD_ACTION_LABELS[card.kind]}
            tone={card.kind === "answer" ? "primary" : "plain"}
            onPress={open}
          />
        )}
        {node.reportPath ? (
          <PillButton
            label="Report"
            onPress={() => openReport(props.environmentId, node.id, node.reportPath!)}
          />
        ) : null}
        {card.kind === "accept" || card.kind === "answer" ? (
          <PillButton label="Open" onPress={open} />
        ) : null}
        <PillButton
          label="⋯"
          accessibilityLabel="More actions"
          onPress={() => props.onOpenSheet(node.id)}
        />
      </View>
    </View>
  );
}

export function WorkstreamCards(props: {
  readonly environmentId: EnvironmentId;
  readonly view: WorkstreamView;
  readonly now: number;
  readonly split: boolean;
  readonly onOpenSheet: (threadId: ThreadId) => void;
}) {
  const commands = useWorkstreamCommands(props.environmentId);
  const cards = props.view.needsYou.flatMap((card) => {
    const node = props.view.nodes.get(card.id);
    return node ? [{ card, node }] : [];
  });
  if (cards.length === 0) return null;
  const accept = (threadId: ThreadId) =>
    runWorkstreamCommand("Couldn't accept", () => commands.setOutcome(threadId, "done"));
  return (
    <View className="gap-2.5 px-3 pt-3 pb-1">
      <Text className="px-1 text-xs font-t3-bold tracking-wide text-warning-foreground">
        NEEDS YOU {cards.length}
      </Text>
      {cards.map(({ card, node }) => (
        <NeedsYouCardView
          key={card.id}
          environmentId={props.environmentId}
          card={card}
          node={node}
          now={props.now}
          split={props.split}
          canOperate={commands.canOperate}
          onAccept={accept}
          onOpenSheet={props.onOpenSheet}
        />
      ))}
    </View>
  );
}
