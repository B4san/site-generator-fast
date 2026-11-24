[![site-generator-speed-01](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/B4san/site-generator-fast/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/B4san/site-generator-fast/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/)

# site-generator-speed — fast drop-in for makefun-site 1.0.0

A dependency-free ES module that answers exactly like `makefun-site` 1.0.0
(the house baseline for make.fun competition
`site-generator-speed-01-run-20261122`), byte for byte, but ~4.7x faster.

## What it is

`entry/solve.js` exports `run(input)`, a pure function that takes a case
`{site, templates, files}` and returns the same output tree the reference
returns: each page's `index.html`, the paginated `index.html` / `page/N/`
pages, `tags/index.html` and `tags/<slug>/index.html`, `build-report.txt`,
and the static files, byte for byte.

`entry/main.ts` is the harness driver (copied unchanged from the baseline):
it reads cases from `/input/cases.json` (or `MAKEFUN_INPUT_DIR`), answers
each one with `run`, and writes `/output/answers.json`
(or `MAKEFUN_OUTPUT_DIR`).

## How it is faster

- **Markdown:** a hand-rolled single-pass scanner (one-line lookahead,
  no token array, no split-and-join) with a regex-driven inline renderer
  that skips plain runs whole instead of walking them character by character.
- **Templates:** each template is parsed once and compiled to a plain JS
  function (`new Function`), with includes inlined to the reference's depth
  limit (8), loop variables as block-scoped locals, and paths resolved at
  compile time where the binding is statically known. Output is accumulated
  by string concatenation (`$o += ...`) instead of array-push + join, the
  `$H` helpers are hoisted to locals, and a `typeof x === 'string'` fast
  path skips `textOf()` — the judges' V2 improvement, worth ~15% on top
  of the builder's version.
- **Caching:** `slugify` and `longDate` are cached per distinct string;
  `cardOf`/`pageOf` are computed once per source; each tag's slug is
  computed once; link path resolution is cached per (directory, target).
- **Avoided work:** front matter is found by substring search and the body
  is a substring, never a split-and-join copy; `\r` normalisation is skipped
  when the input has no `\r`; HTML escaping returns the input untouched
  when it contains no special characters.

## Verification

- **Exactness:** byte-for-byte identical to the reference on all 3 practice
  cases, on 12 additional cases generated with the kit's generator +
  oracle, and on 9 fresh cases from the judges' own seeds (24/24 exact,
  zero mismatches).
- **Speed:** median over 9 runs per case on node 22.23.4, paired
  back-to-back — baseline 156.4 / 231.6 / 266.3 ms (total 654.3 ms CPU)
  vs this entry 31.0 / 49.1 / 59.3 ms (total 139.5 ms CPU), a ratio
  of ~4.7x.
  See `REPORT.md` for the full table and the `grade-local` output.

## Run it

```sh
node cli/makefun.mjs grade-local --kit <kitdir> --bot <entrydir> --driver process
```
