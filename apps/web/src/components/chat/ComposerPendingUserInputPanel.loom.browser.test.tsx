import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

vi.mock(import("../ChatMarkdown"), async (importOriginal) => ({
  ...(await importOriginal()),
  default: (({ text }: { text: string }) => <p>{text}</p>) as never,
}));
// The question age runs a minute timer this test does not need.
vi.mock("~/loom/pendingUserInputLoom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/loom/pendingUserInputLoom")>()),
  PendingQuestionAge: () => null,
}));

import { act, fakeTimers, render } from "../../../test/render";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

const question = (id: string) => ({
  id,
  header: id,
  question: `Which ${id}?`,
  options: [{ label: "Incremental", description: "One module at a time" }],
  multiSelect: false,
});

function panel(questionIndex: number, onAdvance: () => void) {
  return (
    <ComposerPendingUserInputPanel
      pendingUserInputs={[
        {
          requestId: RuntimeRequestId.make("loom-auto-advance"),
          createdAt: "2026-10-26T00:00:00.000Z",
          dismissible: false,
          responseCapability: "live" as const,
          questions: [question("approach"), question("scope")],
        },
      ]}
      cwd="/repo"
      threadRef={threadRef}
      disabled={false}
      respondingRequestIds={[]}
      answers={{}}
      questionIndex={questionIndex}
      onToggleOption={() => {}}
      onAdvance={onAdvance}
      onDismiss={() => {}}
    />
  );
}

it("auto-advances a non-final question but leaves the last one for an explicit Send", async () => {
  const onAdvance = vi.fn();
  await using screen = await render(panel(0, onAdvance));
  using _timers = fakeTimers();
  const chooseOption = () =>
    [...screen.container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Incremental"))!
      .click();

  await act(async () => {
    chooseOption();
    vi.runAllTimers();
  });
  expect(onAdvance).toHaveBeenCalledTimes(1);

  await screen.rerender(panel(1, onAdvance));
  await act(async () => {
    chooseOption();
    vi.runAllTimers();
  });
  expect(onAdvance).toHaveBeenCalledTimes(1);
});
