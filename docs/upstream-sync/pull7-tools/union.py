import sys
for path in sys.argv[1:]:
    out=[];i=0;lines=open(path).readlines();n=0
    while i<len(lines):
        if lines[i].startswith('<<<<<<<'):
            j=i+1;ours=[]
            while j<len(lines) and not lines[j].startswith('======='): ours.append(lines[j]);j+=1
            k=j+1;theirs=[]
            while k<len(lines) and not lines[k].startswith('>>>>>>>'): theirs.append(lines[k]);k+=1
            seen={x.strip() for x in ours if x.strip()}
            out.extend(ours); out.extend(x for x in theirs if x.strip() not in seen)
            n+=1;i=k+1
        else: out.append(lines[i]);i+=1
    open(path,'w').writelines(out); print(f"{n} hunks unioned: {path}")
