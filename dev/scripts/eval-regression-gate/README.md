# Eval regression gate

A small CLI that compares two experiment exports and turns "does this change
make the agent worse?" into an exit code, so a CI job can gate on it.

```bash
node dev/scripts/eval-regression-gate/eval-regression-gate.mjs \
  --baseline baseline.json --candidate candidate.json
```

## Input

Either a bare array of runs, or an object with `runs`, `data` or `results`:

```json
[
  { "runId": "b1", "scenarioId": "checkout", "metrics": { "faithfulness": 0.91, "latency_ms": 810 } }
]
```

`scenarioId` is optional but recommended: every metric is also broken down per
scenario, so a global mean cannot hide one broken slice.

## Output and exit codes

```
metric              baseline   candidate        delta     tol  verdict
----------------------------------------------------------------------
faithfulness          0.8550      0.8050      -0.0500  0.0100  REGRESSED (higher is better)
  └─ refunds: 0.8100 -> 0.7200 (-0.0900)
```

`--format json` and `--format markdown` are also available. Exit codes: `0`
pass, `1` regression, `2` unusable input (so a broken export never reads as a
passing gate).

## Direction and tolerance

Metrics are higher-is-better unless the name contains one of `latency`, `cost`,
`tokens`, `duration` or `error_rate`; override with `--lower-is-better`. Each
metric regresses when it moves the wrong way by more than its tolerance
(`--default-tolerance`, or per metric with `--tolerance faithfulness=0.02`). A
delta sitting exactly on the tolerance passes, so float noise cannot fail a run.

## Tests

`node --test dev/scripts/eval-regression-gate/selftest.mjs` (13 cases, no
workspace dependencies). The script and its test use only `node:` built-ins, so
they run before `pnpm install` in a fresh checkout, which is also why the test
uses `node:test` rather than the workspace runner.
