import * as esbuild from "/home/Carl/.t3/cockpit/worktrees/loom/t3code-ea251a06/node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/lib/main.js";
import fs from "node:fs";
const MARK = /^<<<<<<< [^\n]*\n([\s\S]*?)^=======\n([\s\S]*?)^>>>>>>> [^\n]*\n/m;
function split(src){const parts=[];let rest=src;for(;;){const m=MARK.exec(rest);if(!m){parts.push({text:rest});break;}parts.push({text:rest.slice(0,m.index)});parts.push({ours:m[1],theirs:m[2]});rest=rest.slice(m.index+m[0].length);}return parts;}
function render(parts,mode){return parts.map((p)=>{if(p.text!==undefined)return p.text;if(mode==="ours")return p.ours;if(mode==="theirs")return p.theirs;const seen=new Set(p.ours.split("\n").map(l=>l.trim()).filter(Boolean));const extra=p.theirs.split("\n").filter(l=>!l.trim()||!seen.has(l.trim()));return p.ours+(extra.join("\n").trim()?extra.join("\n").replace(/\n*$/,"\n"):"");}).join("");}
async function parses(src,file){if(!/\.tsx?$/.test(file))return true;try{await esbuild.transform(src,{loader:file.endsWith(".tsx")?"tsx":"ts",jsx:"preserve"});return true;}catch{return false;}}
// Preferred side per the brief's per-area resolution rules; parser picks the first that parses.
const PREF = JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
const ledger=[];
for(const [f,order] of Object.entries(PREF)){
  if(!fs.existsSync(f))continue;
  const src=fs.readFileSync(f,"utf8");
  const parts=split(src);const hunks=parts.filter(p=>p.text===undefined);
  if(!hunks.length)continue;
  let chosen=null;
  for(const mode of order){const out=render(parts,mode);if(await parses(out,f)){chosen=mode;fs.writeFileSync(f,out);break;}}
  ledger.push({file:f,mode:chosen??"FAILED",hunks:hunks.length,
    dropped: !chosen||chosen==="union"?[]:hunks.map(h=>chosen==="ours"?h.theirs:h.ours).filter(t=>t.trim())});
}
fs.writeFileSync(".artifacts/pull7-protected-ledger.json",JSON.stringify(ledger,null,1));
for(const e of ledger) console.log(e.mode.padEnd(7), String(e.hunks).padStart(3), e.file);
