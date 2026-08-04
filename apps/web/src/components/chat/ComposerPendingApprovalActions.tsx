import { type ApprovalRequestId, type ProviderApprovalDecision } from "@t3tools/contracts";
import { memo } from "react";
import { Button } from "../ui/button";

interface ComposerPendingApprovalActionsProps {
  requestId: ApprovalRequestId;
  isResponding: boolean;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
  scheduleComposerFocus: () => void;
}

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  isResponding,
  onRespondToApproval,
  scheduleComposerFocus,
}: ComposerPendingApprovalActionsProps) {
  // Resolving an approval via these buttons is a deliberate composer
  // interaction, so restore focus to the composer once the response resolves
  // ("approve, then keep typing"). This fires only for locally-clicked
  // responses — remotely/other-device-resolved approvals never run this path.
  const respond = (decision: ProviderApprovalDecision) => {
    void onRespondToApproval(requestId, decision).then(() => scheduleComposerFocus());
  };
  return (
    <>
      <Button size="sm" variant="ghost" disabled={isResponding} onClick={() => respond("cancel")}>
        Cancel turn
      </Button>
      <Button
        size="sm"
        variant="destructive-outline"
        disabled={isResponding}
        onClick={() => respond("decline")}
      >
        Decline
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={isResponding}
        onClick={() => respond("acceptForSession")}
      >
        Always allow this session
      </Button>
      <Button size="sm" variant="default" disabled={isResponding} onClick={() => respond("accept")}>
        Approve once
      </Button>
    </>
  );
});
