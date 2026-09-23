import { describe, expect, it } from "vite-plus/test";

import { projectConsultToolFields, readConsultActivityFields } from "./consultActivity.loom.ts";

// `data` payloads copied from the cockpit database (text abbreviated), one per
// shape a real `consult_thread` result takes. The card renders nothing else,
// so these are what protects it from a provider wire change.
const answered = {
  content: [{ type: "text", text: "Answering from this session's context only." }],
  details: {
    ok: true,
    resolved: true,
    threadId: "d21e2aa3-4c45-43cb-85e8-1626acf5649c",
    title: "Ship serve guard; usage-visibility build",
    answer: "Answering from this session's context only.",
  },
  rawInput: { threadId: "d21e2aa3-4c45-43cb-85e8-1626acf5649c", question: "Did it render?" },
};

const ambiguous = {
  content: [{ type: "text", text: "Multiple threads match that name." }],
  details: {
    ok: true,
    resolved: false,
    candidates: [{ threadId: "925b4429-4b68-4552-909a-5c61f9cb46a2", title: "Browser audit" }],
  },
  rawInput: { question: "How did you open the preview?", name: "mdx renderer" },
};

const noMatch = {
  content: [{ type: "text", text: 'No thread matches "loom slack bridge".' }],
  details: {},
  rawInput: { name: "loom slack bridge", question: "What is your status?" },
};

const timedOut = {
  content: [{ type: "text", text: "Timed out waiting for the fork to answer." }],
  details: { ok: false, status: 502, response: { message: "Timed out waiting." } },
  rawInput: { threadId: "202b36a1-31ad-497e-80d3-91dcc4c9723c", question: "Who re-homed goals?" },
};

describe("projectConsultToolFields", () => {
  it("puts the whole exchange of an answered consult on the wire", () => {
    expect(projectConsultToolFields(answered, "consult_thread")).toEqual({
      consult: {
        status: "answered",
        targetThreadId: "d21e2aa3-4c45-43cb-85e8-1626acf5649c",
        targetTitle: "Ship serve guard; usage-visibility build",
        question: "Did it render?",
        answer: "Answering from this session's context only.",
        note: null,
      },
    });
  });

  it("explains an unresolved name and a failure, and still names the thread asked", () => {
    expect(projectConsultToolFields(ambiguous, "consult_thread").consult).toMatchObject({
      status: "unresolved",
      targetThreadId: null,
      answer: null,
      note: "Multiple threads match that name.",
    });
    expect(projectConsultToolFields(noMatch, "consult_thread").consult).toMatchObject({
      status: "failed",
      note: 'No thread matches "loom slack bridge".',
    });
    expect(projectConsultToolFields(timedOut, "consult_thread").consult).toMatchObject({
      status: "failed",
      targetThreadId: "202b36a1-31ad-497e-80d3-91dcc4c9723c",
      note: "Timed out waiting for the fork to answer.",
    });
  });

  it("is pending until the result lands, and projects nothing for other tools", () => {
    expect(
      projectConsultToolFields({ rawInput: { question: "q" } }, "consult_thread").consult,
    ).toMatchObject({ status: "pending", question: "q", answer: null });
    // The lifecycle marker upstream already hides must not become a second card.
    expect(projectConsultToolFields({}, "consult_thread started")).toEqual({});
    expect(projectConsultToolFields(answered, "bash")).toEqual({});
  });

  it("survives the second projection pass the wire applies to its own output", () => {
    const once = projectConsultToolFields(answered, "consult_thread");
    expect(projectConsultToolFields(once, "consult_thread")).toEqual(once);
  });

  it("round-trips through the client reader, which ignores anything else", () => {
    const projected = projectConsultToolFields(answered, "consult_thread");
    expect(readConsultActivityFields(projected)?.question).toBe("Did it render?");
    expect(readConsultActivityFields({ item: { command: "ls" } })).toBe(null);
    expect(readConsultActivityFields(null)).toBe(null);
  });
});
