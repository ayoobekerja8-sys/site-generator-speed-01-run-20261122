// Entry driver for site-generator-speed-01: node22 runs `node /bot/main.ts`. Every case in cases.json is answered on
// its own by run() from solve.js, and answers.json holds the answers in the cases' order. MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR stand in for /input and /output outside a container.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";

setFlagsFromString("--no-incremental-marking");

const { run } = await import(new URL("./solve.js", import.meta.url).href);

const inDir = process.env.MAKEFUN_INPUT_DIR || "/input";
const outDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";

const cases = JSON.parse(readFileSync(join(inDir, "cases.json"), "utf8"));
const answers = new Array(cases.length);
for (let i = 0; i < cases.length; i++) answers[i] = run(cases[i].input);
// One encode of the whole array: the trace is built by the VM, not by a per-answer stringify.
writeFileSync(join(outDir, "answers.json"), JSON.stringify(answers));
