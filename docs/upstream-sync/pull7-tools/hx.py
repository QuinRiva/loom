"""Hunk-level resolver: replace the Nth conflict hunk of a file with given text."""
import re, sys
MARK = re.compile(r'^<<<<<<< [^\n]*\n(.*?)^=======\n(.*?)^>>>>>>> [^\n]*\n', re.M | re.S)

def hunks(path):
    return list(MARK.finditer(open(path).read()))

def resolve(path, spec):
    """spec: dict {hunk_index(1-based): replacement_text or 'ours'/'theirs'}"""
    s = open(path).read()
    ms = list(MARK.finditer(s))
    out = []; last = 0
    for i, m in enumerate(ms, 1):
        out.append(s[last:m.start()])
        if i in spec:
            v = spec[i]
            out.append(m.group(1) if v == 'ours' else m.group(2) if v == 'theirs' else v)
        else:
            out.append(m.group(0))
        last = m.end()
    out.append(s[last:])
    open(path, 'w').write(''.join(out))
    return len(ms)
