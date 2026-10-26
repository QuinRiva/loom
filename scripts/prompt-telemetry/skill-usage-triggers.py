# Missed-fire check: sessions that did the work a skill covers (wrote a plan/recap/explainer MDX, edited an
# instruction file, ran gh issue create, wrote a SKILL.md) and whether they read that skill first.
# Usage: python3 skill-usage-triggers.py [--days 14] [--sessions-root ~/.pi/agent/sessions]
# (forks and /tmp dev instances excluded)
import argparse, json, os, re, sys, time, collections
ap=argparse.ArgumentParser(); ap.add_argument("--days",type=float,default=14)
ap.add_argument("--sessions-root",default=os.path.expanduser("~/.pi/agent/sessions")); args=ap.parse_args()
ROOT=args.sessions_root; cutoff=time.time()-args.days*86400
TRIG={
 "mdx-visual-plan": lambda n,a: n in("write","edit") and re.search(r"plans/[^/]+/plan\.mdx$", str(a.get("path",""))),
 "mdx-visual-recap": lambda n,a: n in("write","edit") and re.search(r"recaps/[^/]+/recap\.mdx$", str(a.get("path",""))),
 "mdx-visual-explainer": lambda n,a: n in("write","edit") and re.search(r"explainers/[^/]+/explainer\.mdx$", str(a.get("path",""))),
 "llm-instruction-change": lambda n,a: n in("write","edit") and re.search(r"(AGENTS\.md|CLAUDE\.md|SKILL\.md|/roles/[^/]+\.md|/prompts?/[^/]+)$", str(a.get("path",""))),
 "report-loom-issue": lambda n,a: n=="bash" and "gh issue create" in str(a.get("command","")),
 "skill-authoring": lambda n,a: n=="write" and str(a.get("path","")).endswith("SKILL.md"),
}
out=collections.defaultdict(lambda: collections.Counter())
roles=collections.defaultdict(collections.Counter)
for d in os.listdir(ROOT):
  dp=os.path.join(ROOT,d)
  if not os.path.isdir(dp): continue
  for f in os.listdir(dp):
    fp=os.path.join(dp,f)
    if not f.endswith(".jsonl") or os.path.getmtime(fp)<cutoff: continue
    first_read={}; first_trig={}; declared=set(); fork=False; tmp=False; role=None; i=0
    for line in open(fp,errors="replace"):
      if '"type":"session"' in line[:40]:
        h=json.loads(line); fork=bool(h.get("parentSession")); tmp=(h.get("cwd") or "").startswith("/tmp")
      if '"toolCall"' not in line and '"role":"system"' not in line: continue
      e=json.loads(line); m=e.get("message") or {}
      if m.get("role")=="system":
        declared|=set(re.findall(r"<name>([^<]+)</name>", (m.get("sections") or {}).get("skills") or ""))
        r=re.search(r"You are an? ([a-z-]+) sub-thread",(m.get("sections") or {}).get("addendum") or "")
        role=role or (r.group(1) if r else "root")
        continue
      for c in m.get("content") or []:
        if not isinstance(c,dict) or c.get("type")!="toolCall": continue
        i+=1; n=c.get("name"); a=c.get("arguments") or {}
        blob=str(a.get("path",""))+" "+str(a.get("command",""))
        for s,t in TRIG.items():
          if s not in first_read and n in("read","read_full","bash") and f"/{s}/SKILL.md" in blob: first_read[s]=i
          if s not in first_trig and t(n,a): first_trig[s]=i
    if fork or tmp: continue
    for s,ti in first_trig.items():
      st = "read before" if s in first_read and first_read[s]<ti else "read after" if s in first_read else "never read"
      out[s][("decl" if s in declared else "undecl")+":"+st]+=1
      roles[s][(role or "terminal")+":"+st]+=1
for s in TRIG: print(s, dict(out[s]), dict(roles[s].most_common(6)))
