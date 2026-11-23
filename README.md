# site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/ayoobekerja8-sys/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/ayoobekerja8-sys/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster reimplementation of makefun-site 1.0.0's `build()`: `solve.js` exports `run(input)` and returns exactly the
same output tree, byte for byte, with a batched HTML escape, a manual word count, cached slugs and templates compiled to
JS functions instead of walked node trees.

## How to verify

`node main.ts` with `MAKEFUN_INPUT_DIR` pointing at the kit's `practice/input` and `MAKEFUN_OUTPUT_DIR` at a scratch
directory writes `answers.json`, which must equal `practice/reference/expected.json` exactly. The same driver with no
environment reads `/input/cases.json` and writes `/output/answers.json`.
