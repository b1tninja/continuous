# RQ10: how many runs per arm, and when to stop

Desk research, no model call. The numbers come from `bench/lab/tools/power.mjs` (exact binomial enumeration and dynamic programs, no simulation; tests in `bench/lab/test/power.test.mjs`). Rerun it with `node bench/lab/tools/power.mjs` (add `--json` for the data). Nothing in the lab reads these figures and no default was changed.

This complements `bench/README.md`, section "How many runs per arm" (#517), which fixes the **stuck experiment's** bar (one-sided Fisher, alpha 0.10, `core/util/stuckExperiment.ts`) and gives 67, 33 and 13 runs per arm for differences of 0.2, 0.3 and 0.5 at worst-case baselines. The lab (`bench/lab`) has different bars, and this document is about those.

## The lab's own bars

- `report` and `suggest` (`lib/stats.mjs`): a rate is printed with a **Wilson 95% interval**; `suggest` says native beats text only "when the intervals are disjoint" (`disjoint(a, b)`) and says `not enough evidence` below `--min-n` 8 runs per arm. Two disjoint 95% intervals are a much stricter test than alpha 0.05: its true type I error is 0.2% to 0.6% (table below), so it needs more runs than a standard test for the same difference.
- `compare`: paired runs, McNemar's exact test on the discordant pairs and a paired bootstrap interval; the verdict is `NOT ENOUGH PAIRS` below 25 pairs, then A better, B better or "no detectable difference".

The tables use two rules on two independent arms of n runs each: **fisher** (two-sided exact test, alpha 0.05, the standard yardstick) and **wilson** (the disjoint-interval rule `suggest` applies). Power is 80%. "Better arm" is the true rate of the better arm: the worse arm sits a difference below it, so a baseline of 100% means a control that never fails against a treatment that sometimes does. Rates near 1 are the case that matters for tool-call validity.

## Smallest difference detected at 80% power, two-sided Fisher exact, alpha 0.05

The better arm's true rate is in the first column; the worse arm is that rate minus the difference. `none` means even 0 against the rate is missed.

| Better arm | n=5  | n=8  | n=10 | n=15 | n=20 | n=30 | n=40 | n=60 | n=80 | n=100 |
| ---------- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ----- |
| 100%       | 0.84 | 0.70 | 0.59 | 0.41 | 0.32 | 0.26 | 0.20 | 0.13 | 0.10 | 0.08  |
| 95%        | 0.84 | 0.71 | 0.65 | 0.49 | 0.40 | 0.31 | 0.25 | 0.19 | 0.16 | 0.14  |
| 90%        | 0.84 | 0.71 | 0.68 | 0.54 | 0.43 | 0.34 | 0.28 | 0.22 | 0.19 | 0.16  |
| 80%        | none | 0.71 | 0.68 | 0.56 | 0.48 | 0.38 | 0.32 | 0.26 | 0.22 | 0.19  |
| 70%        | none | 0.70 | 0.65 | 0.56 | 0.48 | 0.39 | 0.33 | 0.27 | 0.24 | 0.21  |

## Smallest difference detected at 80% power, disjoint Wilson 95% intervals (what `suggest` uses)

The better arm's true rate is in the first column; the worse arm is that rate minus the difference. `none` means even 0 against the rate is missed.

| Better arm | n=5  | n=8  | n=10 | n=15 | n=20 | n=30 | n=40 | n=60 | n=80 | n=100 |
| ---------- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ----- |
| 100%       | 0.96 | 0.81 | 0.68 | 0.55 | 0.42 | 0.29 | 0.25 | 0.17 | 0.13 | 0.11  |
| 95%        | none | 0.81 | 0.74 | 0.57 | 0.49 | 0.38 | 0.31 | 0.24 | 0.20 | 0.17  |
| 90%        | none | 0.81 | 0.76 | 0.60 | 0.53 | 0.41 | 0.35 | 0.28 | 0.24 | 0.20  |
| 80%        | none | none | 0.75 | 0.62 | 0.54 | 0.45 | 0.39 | 0.31 | 0.27 | 0.24  |
| 70%        | none | none | 0.69 | 0.60 | 0.54 | 0.45 | 0.40 | 0.33 | 0.29 | 0.26  |

## Runs per arm for 80% power, two-sided Fisher exact, alpha 0.05

| Better arm | d=0.1 | d=0.2 | d=0.3 | d=0.5 |
| ---------- | ----- | ----- | ----- | ----- |
| 100%       | 78    | 39    | 21    | 12    |
| 95%        | 151   | 55    | 31    | 14    |
| 90%        | none  | 69    | 36    | 17    |
| 80%        | none  | 90    | 44    | 18    |
| 70%        | none  | 102   | 48    | 18    |

## Runs per arm for 80% power, disjoint Wilson 95% intervals (what `suggest` uses)

| Better arm | d=0.1 | d=0.2 | d=0.3 | d=0.5 |
| ---------- | ----- | ----- | ----- | ----- |
| 100%       | 101   | 50    | 29    | 17    |
| 95%        | none  | 78    | 42    | 19    |
| 90%        | none  | 100   | 51    | 22    |
| 80%        | none  | 134   | 64    | 24    |
| 70%        | none  | 154   | 71    | 24    |

## True type I error (worst case over rates 0.1 to 0.95)

| Rule   | n=5   | n=10  | n=20  | n=40  |
| ------ | ----- | ----- | ----- | ----- |
| fisher | 0.021 | 0.013 | 0.025 | 0.033 |
| wilson | 0.002 | 0.003 | 0.006 | 0.006 |

## SPRT on one arm against a bar (alpha 0.05, power 0.8, truncated at 60 runs)

| H0 rate | H1 rate | Success step | Failure step | Accept H1 at H0 | Accept H1 at H1 | Expected runs at H0 | Expected runs at H1 | Undecided at H1 |
| ------- | ------- | ------------ | ------------ | --------------- | --------------- | ------------------- | ------------------- | --------------- |
| 0.70    | 0.90    | +0.251       | -1.099       | 0.046           | 0.861           | 11.6                | 19.6                | 0.007           |
| 0.50    | 0.80    | +0.470       | -0.916       | 0.049           | 0.860           | 7.6                 | 11.4                | 0.000           |
| 0.80    | 0.99    | +0.213       | -2.996       | 0.047           | 0.925           | 5.6                 | 14.2                | 0.000           |

The log likelihood ratio starts at 0, adds the success step on a success and the failure step on a failure, stops for H1 at 2.773 and for H0 at -1.558.

## SPRT on discordant pairs (the sequential McNemar), 4 to 1 in favour of A

| True share for A    | Calls A better | Calls B better | Undecided at 60 | Expected discordant pairs |
| ------------------- | -------------- | -------------- | --------------- | ------------------------- |
| 0.5 (no difference) | 0.049          | 0.951          | 0.000           | 7.6                       |
| 0.8 (4 to 1)        | 0.860          | 0.140          | 0.000           | 11.4                      |

Here "calls B better" means H0 (the share is at most 0.5) was accepted, which is not evidence that B is better.

## Wilson-bound stopping, two arms side by side

Stop as soon as the two arms' Wilson 95% intervals are disjoint; the last look stops with no call.

Looks (runs per arm): 10, 20, 30, 40

| Scenario (control to treatment)     | Calls treatment better | Calls control better | No call | Expected runs per arm |
| ----------------------------------- | ---------------------- | -------------------- | ------- | --------------------- |
| none, 0.70 to 0.70                  | 0.007                  | 0.007                | 0.986   | 39.8                  |
| 0.3 lift, 0.60 to 0.90              | 0.698                  | 0.000                | 0.302   | 31.7                  |
| 0.2 lift near ceiling, 0.80 to 1.00 | 0.579                  | 0.000                | 0.421   | 35.1                  |

Looks (runs per arm): 40

| Scenario (control to treatment)     | Calls treatment better | Calls control better | No call | Expected runs per arm |
| ----------------------------------- | ---------------------- | -------------------- | ------- | --------------------- |
| none, 0.70 to 0.70                  | 0.003                  | 0.003                | 0.994   | 40.0                  |
| 0.3 lift, 0.60 to 0.90              | 0.668                  | 0.000                | 0.332   | 40.0                  |
| 0.2 lift near ceiling, 0.80 to 1.00 | 0.563                  | 0.000                | 0.437   | 40.0                  |

Looks (runs per arm): 5, 10, 15, 20

| Scenario (control to treatment)     | Calls treatment better | Calls control better | No call | Expected runs per arm |
| ----------------------------------- | ---------------------- | -------------------- | ------- | --------------------- |
| none, 0.70 to 0.70                  | 0.005                  | 0.005                | 0.990   | 19.9                  |
| 0.3 lift, 0.60 to 0.90              | 0.286                  | 0.000                | 0.714   | 18.8                  |
| 0.2 lift near ceiling, 0.80 to 1.00 | 0.087                  | 0.000                | 0.913   | 19.9                  |

## What the tables say

- **0.3 is a 20 to 70 run question, not a 10 run one.** For a difference of 0.3 at 80% power, Fisher at alpha 0.05 needs 21 runs per arm when the better arm is at 100%, 31 at 95%, 36 at 90%, 44 at 80% and 48 at 70%. The disjoint-Wilson rule `suggest` uses needs 29, 42, 51, 64 and 71. At n=10 the smallest detectable difference is 0.59 to 0.68 (Fisher) or 0.68 to 0.76 (Wilson); at n=8 the Wilson rule detects nothing below 0.81 and nothing at all from an 80% or 70% baseline.
- **Differences of 0.1 are out of reach.** Fisher needs 78 per arm from 100% against 90%, 151 from 95% and more than 200 from 90% or below; the Wilson rule needs 101 from 100% and more than 200 elsewhere. Do not plan an experiment around a 0.1 difference at these rates.
- **The Wilson rule costs about 40% more runs than Fisher for the same power** (29 against 21 at 100%, 71 against 48 at 70%). It is a cheap, safe way to say "this moved"; for a claim that rests on a 0.3 difference use an exact test, or `compare`'s McNemar on pairs, rather than disjoint intervals.
- **Pairing helps only if the pairs are real.** `compare` pairs by suite, arm, case id and pass index. McNemar discards the pairs where both arms agree, so it can need fewer runs than an unpaired test when cases differ in difficulty; how many fewer depends on how often the arms disagree, which is not known before the first run. `sprtDiscordant` gives the budget in discordant pairs: at 4 discordant pairs to 1 (a 0.8 share) it decides after about 11 discordant pairs on average, and after about 8 when there is no difference. Pairs needed is that count divided by the observed disagreement rate.

## Sequential stopping

Two rules, both exact, both to be pre-registered: fix the thresholds and the maximum before the first run; changing them afterwards is a new experiment.

1. **SPRT on one arm against a bar** (Wald). It answers "is this arm's valid-call rate at the bar, or down at the floor", for example 90% against 70%. Keep a running sum that starts at 0, add `+0.251` after each valid call and `-1.099` after each failure; stop and accept the bar at 2.773, stop and reject it at -1.558. At alpha 0.05 and power 0.8, truncated at 60 runs, the exact false accept rate is 0.046 and the power 0.861; the expected number of runs is 11.6 when the rate is 70% and 19.6 when it is 90%, against 33 runs for a fixed exact one-sided test of the same strength (computed separately, not in the tool). A rate between the two hypotheses can run to the maximum: 0.007 of the mass was still undecided at 60 for the 70/90 pair.
2. **Wilson-bound stopping on two arms**: run both arms side by side, look at 10, 20, 30 and 40 runs each, and stop the first time the two Wilson intervals are disjoint. Repeated looks cost little in type I error here (1.4% two-sided against 0.6% for a single look at 40, because the rule is so conservative) but they also save little: for 0.6 against 0.9 the chance of a call is 0.70 with an expected 31.7 runs per arm, against 0.67 and 40 for a single look at 40; at 0.8 against 1.0 it calls 58% of the time. Looks at 5, 10, 15 and 20 reach a call only 29% of the time for 0.6 against 0.9. Peeking with this rule is safe but does not make a small experiment powerful.

A run stopped early overstates the effect, so report the stopped count with its Wilson interval and say that it stopped early (the same warning as in `bench/README.md`).

## Practical recommendation

- **Screening (is it worth a follow-up):** 10 runs per arm, and only a difference of 0.6 or more can show; say so in the report. Fewer than 8 per arm shows nothing under the Wilson rule, as `suggest`'s `--min-n 8` already implies.
- **A claim that a 0.3 difference is real:** about 20 runs per arm when the better arm is near 100%, 35 to 50 when it is 70% to 90%, with an exact test; 30 to 70 if only the disjoint-Wilson rule is available.
- **A claim about a 0.2 difference:** 40 to 100 per arm (Fisher 39 from a 100% baseline, 69 from 90%, 102 from 70%); decide whether the decision needs it.
- **When to stop early:** a single-arm check against a bar (does the new prompt keep valid calls at 90% rather than 70%) uses the SPRT above with a hard cap of 60. Two-arm comparisons stop early only at a pre-registered look; with looks at 10, 20, 30 and 40 per arm the Wilson-bound stop is safe and saves about 20% of the runs when the effect is real. The Fisher-looks designs in `bench/README.md` save more (about 40% for 0.3 to 0.8) because their test is sharper.
- **When there is no difference** every rule runs to its maximum; budget the maximum.
- **The unit is a run of one model and build**, not a request.

## Limits

- The tables assume independent runs with a fixed success rate. Runs on one case, one seed or one cached prefix are not independent.
- The exact power is a sawtooth in n; `runsForDifference` reports the first n from which power stays at or above 80% (searched to 200), which is a few runs higher than the first n that touches it.
- The detectable-difference search is on a 0.01 grid.
- The 25-pair gate of `compare` and `--min-n 8` of `suggest` are consistent with the tables only for large effects; no exact McNemar power figure is computed here because it depends on the unknown disagreement rate.
