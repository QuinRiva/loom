import sys
N=int(sys.argv[1])
for path in sys.argv[2:]:
    lines=open(path).readlines(); i=0; h=0; buf=[]
    while i<len(lines):
        if lines[i].startswith('<<<<<<<'):
            j=i+1;ours=[]
            while j<len(lines) and not lines[j].startswith('======='): ours.append(lines[j]);j+=1
            k=j+1;theirs=[]
            while k<len(lines) and not lines[k].startswith('>>>>>>>'): theirs.append(lines[k]);k+=1
            h+=1
            def trunc(b):
                if len(b)<=N: return [x.rstrip()[:130] for x in b]
                return [x.rstrip()[:130] for x in b[:N]]+[f"    …(+{len(b)-N} more)"]
            buf.append(f"  --H{h}@{i+1} OURS({len(ours)}):")
            buf += ["   |"+x for x in trunc(ours)]
            buf.append(f"     THEIRS({len(theirs)}):")
            buf += ["   >"+x for x in trunc(theirs)]
            i=k+1
        else: i+=1
    print(f"##### {path}  [{h} hunks]")
    print("\n".join(buf))
