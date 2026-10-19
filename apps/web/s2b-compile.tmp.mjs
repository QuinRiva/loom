import { transform } from "oxc-transform-react";
import fs from "node:fs";
const f = process.argv[2];
const r = await transform(f, fs.readFileSync(f, "utf8"), { jsx: { runtime: "automatic", development: false, refresh: false }, reactCompiler: { reportDiagnostics: true } });
if (process.argv[3]) console.log(r.code); else { console.log(r.errors.map(e=>e.codeframe ?? e.message).join("\n")); }
