#!/bin/bash
# print conflict hunks with context for given files
for f in "$@"; do
  echo "########## $f"
  awk -v F="$f" '
    /^<<<<<<</ {inh=1; start=NR}
    inh {print NR": "$0}
    /^>>>>>>>/ {if(inh){inh=0; print "---"}}
  ' "$f"
done
