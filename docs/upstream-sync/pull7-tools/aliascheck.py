"""Doc-24 alias structural check for SqlSchema query definitions.

Two queries decoding into the SAME Result schema must select the same columns:
a merge that drops a column from one SELECT produces rows that fail to decode
(or silently lose a field) at runtime, and typecheck cannot see it because the
SQL is a string. Reports any query whose alias set is narrower than the widest
set for its Result schema. Inline `Schema.Struct` results group by literal text,
so unrelated inline structs can collide -- check those by hand.
"""
import re, sys, collections
src=open(sys.argv[1]).read()

def select_cols(sql):
    up=sql.upper()
    i=up.find('SELECT')
    if i<0: return None
    # first FROM at paren-depth 0 after SELECT
    depth=0; j=None
    for k in range(i+6, len(sql)):
        c=sql[k]
        if c=='(': depth+=1
        elif c==')': depth-=1
        elif depth==0 and up.startswith('FROM', k) and (k==0 or not sql[k-1].isalnum()):
            j=k; break
    sel=sql[i+6: j if j else len(sql)]
    parts=[]; depth=0; cur=''
    for c in sel:
        if c=='(': depth+=1
        elif c==')': depth-=1
        if c==',' and depth==0:
            parts.append(cur); cur=''
        else: cur+=c
    parts.append(cur)
    out=set()
    for p in parts:
        p=' '.join(p.split())
        if not p: continue
        m=re.search(r'\bAS\s+"([^"]+)"$', p, re.I)
        out.add(m.group(1) if m else p.split('.')[-1])
    return out

by=collections.defaultdict(list)
for m in re.finditer(r'SqlSchema\.(\w+)\(\{(.*?)\n\s*\}\)', src, re.S):
    body=m.group(2)
    r=re.search(r'Result:\s*([A-Za-z_$][\w$.]*)', body)
    sql=''.join(re.findall(r'sql`(.*?)`', body, re.S))
    if not r or not sql: continue
    cols=select_cols(sql)
    if cols: by[r.group(1)].append((src[:m.start()].count('\n')+1, cols))

bad=0
for res, qs in sorted(by.items()):
    if len(qs)<2: continue
    widest=max((c for _,c in qs), key=len)
    for line, cols in qs:
        miss=widest-cols
        if miss:
            bad+=1
            print(f"{res} @ {line}: missing {sorted(miss)}")
print(f"\n{len(by)} Result schemas, {sum(len(v) for v in by.values())} queries, {bad} narrower than widest")
