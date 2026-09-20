import sys
choice=sys.argv[1]
for path in sys.argv[2:]:
    out=[];mode=0;n=0
    for line in open(path):
        if line.startswith('<<<<<<<'): mode=1;n+=1;continue
        if line.startswith('=======') and mode: mode=2;continue
        if line.startswith('>>>>>>>') and mode: mode=0;continue
        if mode==1 and choice=='theirs': continue
        if mode==2 and choice=='ours': continue
        out.append(line)
    open(path,'w').writelines(out)
    print(f"{n} hunks -> {choice}: {path}")
