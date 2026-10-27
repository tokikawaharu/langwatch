// Self-test for the regression gate: node --test dev/scripts/eval-regression-gate/selftest.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  compareRuns,
  formatReport,
  loadRuns,
  main,
  metricNames,
  parseTolerances,
} from "./eval-regression-gate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const baselineRuns = [
  { runId: "b1", scenarioId: "checkout", metrics: { faithfulness: 0.9, latency_ms: 800 } },
  { runId: "b2", scenarioId: "refunds", metrics: { faithfulness: 0.8, latency_ms: 600 } },
];

test("a drop beyond tolerance is reported as a regression", () => {
  const candidate = [
    { runId: "c1", scenarioId: "checkout", metrics: { faithfulness: 0.9, latency_ms: 800 } },
    { runId: "c2", scenarioId: "refunds", metrics: { faithfulness: 0.6, latency_ms: 600 } },
  ];
  const report = compareRuns({ baseline: baselineRuns, candidate, defaultTolerance: 0.01 });
  assert.equal(report.pass, false);
  assert.deepEqual(report.regressions.map((row) => row.metric), ["faithfulness"]);
});

test("a drop inside tolerance passes", () => {
  const candidate = [
    { runId: "c1", scenarioId: "checkout", metrics: { faithfulness: 0.898, latency_ms: 800 } },
    { runId: "c2", scenarioId: "refunds", metrics: { faithfulness: 0.798, latency_ms: 600 } },
  ];
  const report = compareRuns({ baseline: baselineRuns, candidate, defaultTolerance: 0.01 });
  assert.equal(report.pass, true);
});

test("latency is judged in the opposite direction", () => {
  const candidate = [
    { runId: "c1", scenarioId: "checkout", metrics: { faithfulness: 0.9, latency_ms: 950 } },
    { runId: "c2", scenarioId: "refunds", metrics: { faithfulness: 0.8, latency_ms: 750 } },
  ];
  const report = compareRuns({ baseline: baselineRuns, candidate, defaultTolerance: 0.01 });
  assert.equal(report.pass, false);
  assert.deepEqual(report.regressions.map((row) => row.metric), ["latency_ms"]);
});

test("invalid latency improvement passes", () => {
  const candidate = [
    { runId: "c1", scenarioId: "checkout", metrics: { faithfulness: 0.9, latency_ms: 700 } },
    { runId: "c2", scenarioId: "refunds", metrics: { faithfulness: 0.8, latency_ms: 500 } },
  ];
  assert.equal(compareRuns({ baseline: baselineRuns, candidate, defaultTolerance: 0.01 }).pass, true);
});

test("per-scenario rows expose which slice regressed", () => {
  const candidate = [
    { runId: "c1", scenarioId: "checkout", metrics: { faithfulness: 0.9, latency_ms: 800 } },
    { runId: "c2", scenarioId: "refunds", metrics: { faithfulness: 0.5, latency_ms: 600 } },
  ];
  const report = compareRuns({ baseline: baselineRuns, candidate, defaultTolerance: 0.01 });
  const row = report.rows.find((entry) => entry.metric === "faithfulness");
  assert.ok(row);
  const slice = row.perScenario.find((entry) => entry.regressed);
  assert.ok(slice);
  assert.equal(slice.scenario, "refunds");
});

test("metric names are unioned from both exports", () => {
  const names = metricNames({ runSets: [baselineRuns, [{ runId: "x", metrics: { cost_usd: 0.02 } }]] });
  assert.deepEqual(names, ["cost_usd", "faithfulness", "latency_ms"]);
});

test("wrapped exports are unwrapped", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-"));
  const path = join(dir, "wrapped.json");
  writeFileSync(path, JSON.stringify({ data: baselineRuns }), "utf8");
  assert.equal(loadRuns({ path }).length, 2);
});

test("an export with no metrics object is rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-"));
  const path = join(dir, "bad.json");
  writeFileSync(path, JSON.stringify([{ runId: "x" }]), "utf8");
  assert.throws(() => loadRuns({ path }), /has no metrics object/);
});

test("tolerance parsing accepts pairs and rejects nonsense", () => {
  assert.deepEqual(parseTolerances({ value: "faithfulness=0.02,cost=0.5" }), { faithfulness: 0.02, cost: 0.5 });
  assert.throws(() => parseTolerances({ value: "faithfulness" }), /metric=value/);
});

test("markdown and text reports both name the failing metric", () => {
  const candidate = [
    { runId: "c1", scenarioId: "checkout", metrics: { faithfulness: 0.4, latency_ms: 800 } },
    { runId: "c2", scenarioId: "refunds", metrics: { faithfulness: 0.4, latency_ms: 600 } },
  ];
  const report = compareRuns({ baseline: baselineRuns, candidate, defaultTolerance: 0.01 });
  assert.match(formatReport({ report, format: "text" }), /FAIL: faithfulness/);
  assert.match(formatReport({ report, format: "markdown" }), /REGRESSED/);
  assert.equal(JSON.parse(formatReport({ report, format: "json" })).pass, false);
});

test("the CLI exits 1 on the fixture regression and 0 when tolerances absorb it", () => {
  const baseline = join(HERE, "fixtures", "baseline.json");
  const candidate = join(HERE, "fixtures", "candidate.json");
  assert.equal(main({ argv: ["--baseline", baseline, "--candidate", candidate] }), 1);
  assert.equal(
    main({
      argv: [
        "--baseline",
        baseline,
        "--candidate",
        candidate,
        "--tolerance",
        "faithfulness=2,answer_relevancy=2,latency_ms=100",
      ],
    }),
    0,
  );
});

test("a delta sitting exactly on the tolerance does not regress", () => {
  const baseline = [{ runId: "b", metrics: { faithfulness: 0.85 } }];
  const candidate = [{ runId: "c", metrics: { faithfulness: 0.84 } }];
  assert.equal(compareRuns({ baseline, candidate, defaultTolerance: 0.01 }).pass, true);
});

test("the CLI exits 2 on missing arguments", () => {
  assert.equal(main({ argv: [] }), 2);
  assert.equal(main({ argv: ["--baseline", "only.json"] }), 2);
});
