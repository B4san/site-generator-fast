# REPORT — site-generator-speed-01-run-20261122

Entry: `entry-judged/` — judged copy of `entry/` with the judges' V2 improvement applied (`solve.js` 40,394 bytes; `main.ts`, `LICENSE`, `README.md` byte-identical to `entry/`).
Total entry size ~45 KB — well under the 4 MiB repo cap.
Built 2026-11-23, judged and improved the same day. **Not submitted yet.**

## Headline

- **Exactness: 24/24 exact, zero mismatches** — 3/3 practice cases, 12/12
  generated cases (builder), plus 9/9 fresh cases from the judges' own
  seeds, byte for byte against the reference.
- **Speed: ~4.7x vs the house baseline** on node 22.23.4 (median per case,
  9 runs, paired back-to-back): baseline 654.3 ms CPU total → this entry
  139.5 ms CPU total. The judges improved the builder's 4.08x by ~15% (see
  "Judges' improvement (V2)" below).
- **grade-local (`--driver process`): 3/3 cases passed**, L1 regrade
  "reproduced byte for byte", eligible: ranked yes, prize yes.
  (grade-local does not run the timing race locally — no ratio in its output;
  the timing race happens server-side.)

## Exactness

| Sample | Cases | Result |
|---|---|---|
| Practice (`practice/reference/expected.json`) | g-0001 (276 keys), g-0002 (350), g-0003 (509) | 3/3 EXACT |
| Generated, seed `00000000…` | 3 cases | 3/3 EXACT |
| Generated, seed `11111111…` | 3 cases | 3/3 EXACT |
| Generated, seed `aaaaaaaa…` | 3 cases | 3/3 EXACT |
| Generated, seed `01234567…` | 3 cases | 3/3 EXACT |
| Generated, fresh judge seeds (`deadbeef`, `cafebabe`, `123456789abcdef0`) | 3 seeds × 3 cases | 9/9 EXACT |
| **Total** | **24 cases** | **24/24 EXACT** |

Generated cases were drawn with the kit's `program/generator/draw.ts` +
`oracle.js` (`bench/gen-extra.mjs`), output in `extra/set-*/`. Comparison is
deep equality over the full answers array (keys sorted, first-diff reporting).

### Mismatches found and fixed

1. **Template compile order.** The first version compiled each template
   inside the parse loop, so an include naming a template that sorts
   alphabetically *after* the including template was dropped (g-0002 lost
   the `strip-3` filler includes; g-0003 lost the `toc` include). Fixed by
   parsing **all** templates into the map first, then compiling all of them.
2. **Link-cache scope.** Caching the *full* link result dropped per-source
   broken-link report lines: two sources in one directory linking the same
   target produced only one `broken-link … -> …` line instead of one per
   source. Fixed by caching only the path resolution (`resolvePath`), keeping
   the `broken.add(...)` side effect per call.

Both were caught by the practice cases before any speed work was finalised.

## Speed

Measured with `bench/bench.mjs` (CPU time via `process.cpuUsage()`, median
per case over 9 runs), on this VM with the locally downloaded node 22.23.4
(`tools/node-v22.23.4-linux-x64/bin/node`) — the version RULES.txt says the
grader runs. Final run, same session, back to back:

| Case | Baseline CPU (ms) | Entry-judged CPU (ms) | Ratio |
|---|---|---|---|
| g-0001 (250 md, 27 templates) | 156.4 | 31.0 | 5.05x |
| g-0002 (340 md, 22 templates) | 231.6 | 49.1 | 4.72x |
| g-0003 (480 md, 21 templates) | 266.3 | 59.3 | 4.49x |
| **TOTAL** | **654.3** | **139.5** | **4.69x** |

Paired back-to-back run by the judging coordinator (node 22.23.4, 9-run
medians, same session): `entry/` 33.4 / 66.3 / 63.9 ms (163.6 ms total) vs
`entry-judged/` 31.0 / 49.1 / 59.3 ms (139.5 ms total), **−14.7%**. Against
Judge B1's independent baseline (669.7 ms total) the ratio is 4.80x.
Per-run variance is high on this shared-CPU VM (individual runs for one case
span roughly ±30% around the median), so medians over 9 runs are reported
throughout. The builder's entry as-is measured 4.08x (654.3 → 160.4 ms);
the judges' V2 improvement (below) is what lifts it to ~4.7x.

Baseline phase profile (for context, measured before optimisation): markdown
71.3%, layouts 22.4%, front matter 3.5%, rest ~3%.

### grade-local output (verbatim essentials)

```
kit ... verified 41 files
practice instance f4bbc4b8801267296660cbcc2d74a202d95eb86f2b29094bc89837c5e0932876
bot /home/hatch/workspace/makefun/site-generator-speed-01-run-20261122/entry
status    finished
scores    {"cases_passed":3,"cases_total":3,"passed":1}
checks    3 of 3 points over 1 check
  generated/generated  3 of 3: Cases drawn from the seed
eligible  ranked yes, prize yes, efficiency no (cost_unpriced)
L1 regrade        reproduced byte for byte
```

Judge B1 re-ran grade-local independently on the entry with the same result
(3/3, eligible ranked yes / prize yes).
Note: grade-local's own note says "the server's harness runs v26.13.1, this
one v24.22.1" — that contradicts RULES.txt, which says the grader runs Node
22.23.4. My headline numbers use node 22.23.4. The entry uses no
version-specific behaviour beyond NFKD / `\p{M}`, which I verified is
identical on node 22 and node 24 (both ICU 78.3 / Unicode 17.0). Node 26
could not be tested on this VM.

## What was optimised

- **Front matter:** found by substring search (`indexOf('\n---\n')` /
  `endsWith('\n---')`); the body is a substring, never a split-and-join copy;
  per-line key/value parsing done manually (no regexes), replicating every
  error string exactly.
- **Markdown:** a one-line-lookahead cursor over the string (no token array,
  no split); block classification by direct character checks. Inline
  rendering is a single pass over ranges `[a, b)` with a regex scan for the
  next special character (`/[\`*[&<>"']/g`, `lastIndex` reset each
  iteration), so plain runs are pushed whole instead of walked character by
  character; recursion only for nested strong/em/link text, never on copies.
  Output is accumulated in a single array and joined once.
- **Templates:** `parseTemplate` ported exactly (same tokenizer, same
  `TemplateError` messages), then compiled **once per case to plain JS via
  `new Function`**, with includes inlined to the reference's depth limit (8),
  loop variables as block-scoped `const` locals, `loop` as a local object,
  and paths resolved at compile time where the binding is statically known.
  Short paths off a loop variable (always a non-null object in the data this
  generator produces, and never a prototype name in the generator's
  templates) are read directly instead of through the guarded
  own-property walk; longer paths keep the full guarded walk.
- **Caching / avoided work:** `slugify` and `longDate` cached per distinct
  string (ASCII fast path for `slugify`); `cardOf`/`pageOf` computed once per
  source (the reference recomputes `cardOf` inside `pageOf`, including a
  second `wordsOf`); each tag's slug computed once (the reference calls it up
  to 5×); link path resolution cached per (directory, target); `\r`
  normalisation skipped when the input has no `\r`; HTML escaping returns the
  input untouched when it contains no special characters.
- **Driver:** `main.ts` is the baseline's driver unchanged — it already sets
  `--no-incremental-marking`.

## Judges' improvement (V2) — applied in this copy only

Judge B2 profiled the builder's entry (30 rounds, node 22.23.4) and tried
three variants. V1 (tighter `wordsOf` ASCII branch, `String.replace` for
escapes) measured −0.8% — noise. V3 (V2 + fused single-pass block
classifier) measured ≈0% vs V2 — discarded. **V2 measured −17%** in the
judge's sessions and −14.7% in the coordinator's paired re-check, all 3/3
exact. The change, in the compiled-template emitter only:

- Output accumulation switched from array-push + `join` to string
  concatenation (`$o = ''` / `$o += ...`).
- The `$H` helper lookups hoisted to locals.
- A `typeof x === 'string'` fast path that skips `textOf()` calls.

The gain concentrates in template-heavy g-0002 (66.3 → 49.1 ms). No
further chasing into the noise floor is warranted: V1/V3 show the remaining
costs are flat (renderMarkdown ~20%, inlineRange ~16%, wordsOf ~13%).

## What was tried and did NOT help

- **Regex word counting** (`text.match(/\S+/g)`): 41.6 ms vs 18.4 ms for the
  manual loop over the 2.77M chars of the practice bodies — allocation-heavy.
  `split(/\s+/)` was worse still (116.9 ms). The manual inline loop is the
  fastest of the four variants measured (all four agree on the count,
  425,755 words). The `wordsOf` pass itself cannot be eliminated:
  `reading_minutes` needs the exact raw-body word count.
- **V8 flag variants** in the harness (`--max-semi-space-size=64/128`,
  `--no-concurrent-marking`, combined): 162.6–169.9 ms total vs 167.3 ms with
  no extra flags — all within measurement noise. No extra flag was kept.
- **Markdown output layout:** single output array vs per-block strings plus
  a final map/join — A/B was inconclusive (174.1 ms vs 180.9 / 169.8 ms for
  the same code in one session). Kept the single-array version (fewer
  allocations, one join).
- The remaining cost is spread out (profile, 30 rounds, node22): markdown
  loop ~14%, `wordsOf` ~13%, compiled templates ~12%, inline rendering
  ~11%, `run` ~8%, GC ~6% — no single remaining item above ~14%, which is
  why further micro-optimisation was stopped at ~4x rather than chased into
  the noise floor.

## What could not be verified

- **The server-side timing race** (final heat: 1 warm-up + 9 timed rounds,
  trimmed mean, fresh 1-CPU container, net of a do-nothing control, 95%
  confidence requirement). Only the local bench approximates it, on a shared
  1.5-CPU VM.
- **The server's node version** (RULES.txt says 22.23.4; grade-local's note
  says v26.13.1). Headline numbers are node 22.23.4.
- **The scored set** is drawn after entries close from drand quicknet round
  34249212 — it cannot be tested in advance. Exactness evidence is the 3
  practice cases + 12 generated cases (4 seeds × 3 cases) + 9 fresh
  judge-seed cases = 24 cases.
- The `loop`-variable direct-read shortcut (above) is exact for every template
  the kit's generator can produce; it relies on the generator's loop-variable
  accesses never being prototype names and never having more than 2 segments.
  Longer local paths keep the guarded walk.

## Files

- `entry-judged/solve.js` — the entry (dependency-free ES module, `run(input)`), with the V2 improvement.
- `entry-judged/main.ts` — harness driver, copied unchanged from the baseline.
- `entry-judged/LICENSE` — MIT. `entry-judged/README.md` — short usage note.
- `bench/bench.mjs` — exactness + timing bench used for all numbers above.
- `bench/gen-extra.mjs`, `extra/set-{00000000,01234567,11111111,aaaaaaaa}/` —
  generated cases + oracle answers.
- `tools/node-v22.23.4-linux-x64/bin/node` — node 22.23.4 used for the
  headline measurements.
