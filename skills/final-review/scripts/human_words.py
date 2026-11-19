"""Every message the human wrote in a goal, verbatim, in time order, as markdown.

Usage: python3 human_words.py <thread-id>  (any thread of the goal; read-only against Loom's live database)
"""
import glob, json, os, re, sqlite3, sys, urllib.parse
from datetime import datetime, timezone

HOME = os.environ.get("T3CODE_HOME", os.path.expanduser("~/.t3"))
db = sqlite3.connect(f"file:{HOME}/userdata/statev2.sqlite?mode=ro", uri=True)
q = lambda sql, *a: db.execute(sql, a).fetchall()
TAIL, HEAD = 500, 300
TEXT = "json_extract(payload_json,'$.text')"

if len(sys.argv) != 2:
    sys.exit(__doc__)
goal, root = (q("select goal_id, root_thread_id from loom_thread_workstream where thread_id=?", sys.argv[1]) or [(None, None)])[0]
if not goal:
    sys.exit(f"{sys.argv[1]} is not a thread of any goal")
threads = dict(q("""select w.thread_id, t.title || ' [' || coalesce(w.role, 'root') || ']'
  from loom_thread_workstream w join orchestration_v2_projection_threads t using(thread_id) where w.goal_id=?""", goal))
marks = lambda ids: ",".join("?" * len(ids))
latest = q(f"select max(created_at) from orchestration_v2_projection_messages where thread_id in ({marks(threads)})", *threads)[0][0]


def agent_text(tid, where, order, *args):
    rows = q(f"""select {TEXT} from orchestration_v2_projection_messages where thread_id=? and role='assistant'
      and streaming=0 and {TEXT}<>'' and {where} order by created_at {order} limit 1""", tid, *args)
    return rows[0][0] if rows else None


def render(text, records):
    """Expand the links a message carries, in text order: review comments, assistant quotes, thread mentions, images."""
    recs = {r["contextId"]: r for r in records}
    notes = []

    def note(label, agent, human, placeholder):
        notes.append((f"note {len(notes) + 1}: {label}", agent, human))
        return f"[note {len(notes)}: {placeholder}]"

    def link(m):
        if m[4]:
            p = urllib.parse.parse_qs(urllib.parse.urlparse(m[4]).query)
            return note(f"quote of the agent's text: {p.get('text', [''])[0]!r}", None, p.get("comment", ["(no comment)"])[0], "assistant quote")
        r = recs.get(m[3].split("?")[0])
        if r is None:
            return f"[{m[2]}: {m[1]}]"
        if r["kind"] == "image":
            return f"[image the human attached: {' '.join(glob.glob(f'{HOME}/userdata/attachments/{r.get("attachmentId")}.*')) or m[1]}]"
        if r["kind"] == "thread":
            return f"[thread: {r['title']}]"
        t, label = r.get("text", ""), r.get("rangeLabel", "")
        anchor = r.get("mdxAnchor", {}).get("quotedText") or (r.get("diff") or "").splitlines()[-1:]
        anchor = anchor if isinstance(anchor, str) else "".join(anchor)
        where = f"{r.get('filePath')} {label}".strip()
        if label == "promoted":
            return note(f"promoted comment on {where}: an AGENT's distillation of a document query, which the human sent", t, None, "promoted comment")
        fm = re.match(r"Q: (.*) → (chose|wrote in): (.*)$", t, re.S)
        if fm:
            val = re.match(r'^"(.*)"( \(the recommended option\))?$', fm[3].strip(), re.S)
            kind = (f"The human PICKED this option{' (the recommended one)' if val and val[2] else ''}; its wording is the document's"
                    if fm[2] == "chose" else "The human WROTE IN")
            return note(f"form answer on {where}. Question (document's text): {fm[1]}. {kind}:", None, val[1] if val else fm[3], f"form answer: {label}")
        return note(f"comment on {where}, anchored on (document's text): {anchor!r}", None, t, f"comment: {r.get('label')}")

    return re.sub(r"!?\[([^\]]*)\]\(t3-context://v1/([a-z-]+)/([^)\s]+)\)|\[Assistant quote\]\((t3-citation://[^)\s]+)\)", link, text), notes


entries = []  # (time, thread, kind, human_text, notes, agent_before, agent_reply)


def human_messages(tids, extra_where="", *args):
    for tid, mid, run, at, p in q(f"""select thread_id, message_id, run_id, created_at, payload_json from orchestration_v2_projection_messages
        where thread_id in ({marks(tids)}) and role='user' and json_extract(payload_json,'$.loom.humanAuthored')=1
        and message_id not like 'async-answer:%' {extra_where} order by created_at""", *tids, *args):
        p = json.loads(p)
        text, notes = render(p["text"], p.get("context", {}).get("records", []))
        flags = []
        if mid.startswith("message:server:"):
            flags.append(("FLAG: server-composed text sent on the human's behalf (e.g. a document-query promote), not typed by them", None, None))
        if text.lstrip().startswith("/"):
            flags.append(("FLAG: starts with '/': may be a slash command, not prose", None, None))
        cont = q("select continues_thread_id from loom_thread_workstream where thread_id=?", tid)
        if cont and cont[0][0] and at == q("select min(created_at) from orchestration_v2_projection_messages where thread_id=? and role='user'", tid)[0][0]:
            flags.append(("FLAG: first message of a goal continuation: an agent's brief the human edited before sending", None, None))
        before = agent_text(tid, "created_at<?", "desc", at)
        # A question's answer is the agent's last message in the run the message started or steered.
        asks = "?" in text + "".join(h or "" for _, _, h in notes)
        reply = asks and run and agent_text(tid, "created_at>? and run_id=?", "desc", at, run)
        yield (at, tid, "message" + (f" ({p['creationSource']})" if p.get("creationSource") != "web" else ""), text,
               flags + notes, before and before[-TAIL:], reply and reply[:HEAD])


entries += human_messages(list(threads))

# Questions put with ask_user_question: an answer given while the agent waits becomes a tool result and never a
# message, so read the turn item. One with no answer and still waiting is open with the human.
asked, open_questions = q(f"""select thread_id, payload_json from orchestration_v2_projection_turn_items where type='user_input_request'
    and thread_id in ({marks(threads)}) and (json_extract(payload_json,'$.questionAnswer') is not null or status='waiting')""", *threads), []
for tid, p in asked:
    p = json.loads(p)
    for qu in p["questions"]:
        opts = "; ".join(o["label"] for o in qu.get("options", []))
        ctx = f"QUESTION ({qu.get('header')}): …{qu['question'][-TAIL:]}\nOPTIONS: {opts}"
        if not p.get("questionAnswer"):
            open_questions.append((p["startedAt"], tid, ctx))
            continue
        ans = p["questionAnswer"]["answers"].get(qu["id"])
        if ans is None:
            continue
        ans = ans if isinstance(ans, str) else json.dumps(ans)
        picked = any(ans.strip() in (o.get("value"), re.sub(r"\s*\(Recommended\)$", "", o["label"])) for o in qu.get("options", []))
        entries.append((p["completedAt"], tid, "answer to agent question, " + ("PICKED an option (its wording is the agent's)" if picked else "typed their own answer"), ans, [], ctx, None))

# Goal handoff: a handed-off thread's first message is another agent's brief. The human's words are in the run of the
# source thread that called goal_handoff; follow handoff_origin back, hop by hop.
hops, followed = [], set()
for (cur,) in q(f"select thread_id from loom_thread_workstream where thread_id in ({marks(threads)}) and handoff_origin is not null", *threads):
    while cur not in followed and (h := q("select handoff_origin from loom_thread_workstream where thread_id=?", cur)) and h[0][0]:
        followed.add(cur)
        src = json.loads(h[0][0])["threadId"]
        runs = [r for (r,) in q("""select run_id from orchestration_v2_projection_turn_items where thread_id=? and type='dynamic_tool'
            and json_extract(payload_json,'$.toolName') like '%goal_handoff' and instr(payload_json, ?)>0""", src, cur)]
        title = q("select title from orchestration_v2_projection_threads where thread_id=?", src)[0][0]
        hops.append(f"{cur} was handed off by `{src}` ({title}), runs {runs}")
        threads.setdefault(src, f"{title} [HANDOFF SOURCE, outside this goal]")
        entries += human_messages([src], f"and run_id in ({marks(runs)})", *runs)
        cur = src

entries.sort(key=lambda e: e[0])
out = [f"# The human's words: {q('select title from orchestration_v2_projection_threads where thread_id=?', root)[0][0]}\n",
       f"Goal `{goal}`, root `{root}`. {len(entries)} entries across {len({e[1] for e in entries})} of {len(threads)} threads. Times are UTC.\n",
       "The human's text is inside the `~~~` fences, verbatim; everything else is the agent's or the document's text, marked. "
       "Inside a fence, a bracketed `[image the human attached: …]` or `[thread: …]` stands where their message carried a link, and a "
       "numbered `[note N: …]` stands where it carried a comment, a form answer or an assistant quote; note N after the fence holds what that link held. "
       "PICKED marks an option the human chose; its wording is the agent's or the document's, not theirs. "
       "Where the human asked something, the start of the agent's reply follows, marked. "
       "Questions agents have put to the human that are still unanswered are listed at the end.\n",
       f"Read from Loom's live database at {datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC; the latest message in this goal's threads, from anyone, is at {latest[:16].replace('T', ' ')}.\n"]
out += [f"Handoff trail: {h}\n" for h in hops] or ["No handoff: no thread of this goal was started by another agent's handoff.\n"]
shown = {}
for i, (at, tid, kind, text, notes, before, reply) in enumerate(entries, 1):
    out.append(f"\n## {i}. {at[:16].replace('T', ' ')} · {threads[tid]} · {kind}\n")
    out.append(f"`{tid}`\n")
    if before and (tid, "before", before) in shown:
        out.append(f"> **Agent, just before:** no agent message since entry {shown[tid, 'before', before]}.\n")
    elif before:
        shown[tid, "before", before] = i
        out.append("> **Agent, just before (context, not the human):** " + before.replace("\n", "\n> ") + "\n")
    out.append(f"~~~text\n{text}\n~~~\n")
    for label, agent, human in notes:
        out.append(f"- **{label}**" + (f"\n  > (agent text) {agent}" if agent else "") + "\n")
        if human is not None:
            out.append(f"~~~text\n{human}\n~~~\n")
    if reply and (tid, "reply", reply) in shown:
        out.append(f"> **Agent's reply:** the same message as the reply shown at entry {shown[tid, 'reply', reply]}.\n")
    elif reply:
        shown[tid, "reply", reply] = i
        out.append("> **Agent's reply, its start (not the human):** " + reply.replace("\n", "\n> ") + "\n")
out.append(f"\n## Still unanswered: {len(open_questions)} question(s) agents have put to the human\n")
out.append("These are questions asked with the question tool and never answered through it; a later message of the human's above may "
           "still have settled one. A question asked in an agent's message or in a document's form is not listed.\n")
out += [f"- {at[:16].replace('T', ' ')} · {threads[tid]} · `{tid}`\n  > " + ctx.replace("\n", "\n  > ") + "\n" for at, tid, ctx in sorted(open_questions)]
print("\n".join(out))
