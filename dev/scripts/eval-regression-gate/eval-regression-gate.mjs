// Compare two experiment exports and fail the run on a metric regression.
import { readFileSync } from "node:fs";

export const LOWER_IS_BETTER = ["latency", "cost", "tokens", "duration", "error_rate"];

// Exports arrive either as a bare array or wrapped under runs/data/results.
export function loadRuns({ path }) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const runs = Array.isArray(raw) ? raw : (raw.runs ?? raw.data ?? raw.results);
  if (!Array.isArray(runs)) {
    throw new Error(`${path}: expected an array of runs, or an object with runs/data/results`);
  }
  runs.forEach((run, index) => {
    if (run === null || typeof run !== "object" || typeof run.metrics !== "object" || run.metrics === null) {
      throw new Error(`${path}: run #${index} has no metrics object`);
    }
  });
  return runs;
}

export function isLowerBetter({ metric, lowerIsBetter }) {
  const name = metric.toLowerCase();
  return lowerIsBetter.some((token) => name.includes(token.toLowerCase()));
}

export function mean({ values }) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// Tolerance comparison carries a tiny epsilon so a delta sitting exactly on the
// boundary is not flipped by float noise (0.85 - 0.84 computes as -0.0100000009).
const EPSILON = 1e-9;

export function isRegression({ delta, tolerance, lowerIsBetter }) {
  return lowerIsBetter ? delta > tolerance + EPSILON : delta < -(tolerance + EPSILON);
}

export function metricNames({ runSets }) {
  const names = new Set();
  for (const runs of runSets) {
    for (const run of runs) {
      for (const metric of Object.keys(run.metrics)) names.add(metric);
    }
  }
  return [...names].sort();
}

export function valuesFor({ runs, metric }) {
  return runs.map((run) => run.metrics[metric]).filter((value) => typeof value === "number" && Number.isFinite(value));
}

export function scenarioIds({ runSets }) {
  const ids = new Set();
  for (const runs of runSets) {
    for (const run of runs) {
      if (typeof run.scenarioId === "string") ids.add(run.scenarioId);
    }
  }
  return [...ids].sort();
}

export function compareRuns({
  baseline,
  candidate,
  tolerances = {},
  defaultTolerance = 0.01,
  lowerIsBetter = LOWER_IS_BETTER,
}) {
  const scenarios = scenarioIds({ runSets: [baseline, candidate] });
  const rows = [];
  for (const metric of metricNames({ runSets: [baseline, candidate] })) {
    const tolerance = tolerances[metric] ?? defaultTolerance;
    const lowerBetter = isLowerBetter({ metric, lowerIsBetter });
    const baseValues = valuesFor({ runs: baseline, metric });
    const candValues = valuesFor({ runs: candidate, metric });
    if (baseValues.length === 0 && candValues.length === 0) continue;

    const baseMean = mean({ values: baseValues });
    const candMean = mean({ values: candValues });
    const delta = candMean - baseMean;
    rows.push({
      metric,
      baseline: round({ value: baseMean }),
      candidate: round({ value: candMean }),
      delta: round({ value: delta }),
      tolerance,
      lowerIsBetter: lowerBetter,
      samples: { baseline: baseValues.length, candidate: candValues.length },
      regressed: isRegression({ delta, tolerance, lowerIsBetter: lowerBetter }),
      perScenario: scenarioRows({ baseline, candidate, scenarios, metric, tolerance, lowerIsBetter: lowerBetter }),
    });
  }

  const regressions = rows.filter((row) => row.regressed);
  return { rows, regressions, pass: regressions.length === 0 };
}

// A per-scenario view keeps one broken slice from hiding behind a global mean.
export function scenarioRows({ baseline, candidate, scenarios, metric, tolerance, lowerIsBetter }) {
  const rows = [];
  for (const scenario of scenarios) {
    const baseSlice = valuesFor({ runs: baseline.filter((run) => run.scenarioId === scenario), metric });
    const candSlice = valuesFor({ runs: candidate.filter((run) => run.scenarioId === scenario), metric });
    if (baseSlice.length === 0 || candSlice.length === 0) continue;
    const baseMean = mean({ values: baseSlice });
    const candMean = mean({ values: candSlice });
    const delta = candMean - baseMean;
    rows.push({
      scenario,
      baseline: round({ value: baseMean }),
      candidate: round({ value: candMean }),
      delta: round({ value: delta }),
      regressed: isRegression({ delta, tolerance, lowerIsBetter }),
    });
  }
  return rows;
}

export function round({ value }) {
  return Math.round(value * 10000) / 10000;
}

export function formatReport({ report, format = "text", toleranceNote = "" }) {
  if (format === "json") return JSON.stringify(report, null, 2);

  if (format === "markdown") {
    const lines = ["| metric | baseline | candidate | delta | verdict |", "| --- | --- | --- | --- | --- |"];
    for (const row of report.rows) {
      const sign = row.delta > 0 ? "+" : "";
      lines.push(
        `| ${row.metric} | ${fixed({ value: row.baseline })} | ${fixed({ value: row.candidate })} | ${sign}${fixed({ value: row.delta })} | ${row.regressed ? "**REGRESSED**" : "ok"} |`,
      );
    }
    lines.push("", report.pass ? "Verdict: pass" : `Verdict: ${report.regressions.length} regression(s)`);
    return lines.join("\n");
  }

  const width = Math.max(6, ...report.rows.map((row) => row.metric.length));
  const header = `${"metric".padEnd(width)}  ${"baseline".padStart(10)}  ${"candidate".padStart(10)}  ${"delta".padStart(11)}  ${"tol".padStart(6)}  verdict`;
  const lines = [header, "-".repeat(header.length)];
  for (const row of report.rows) {
    const direction = row.lowerIsBetter ? "lower is better" : "higher is better";
    const sign = row.delta > 0 ? "+" : "";
    lines.push(
      `${row.metric.padEnd(width)}  ${fixed({ value: row.baseline }).padStart(10)}  ` +
        `${fixed({ value: row.candidate }).padStart(10)}  ${(sign + fixed({ value: row.delta })).padStart(11)}  ` +
        `${fixed({ value: row.tolerance }).padStart(6)}  ${row.regressed ? "REGRESSED" : "ok"} (${direction})`,
    );
    for (const slice of row.perScenario.filter((entry) => entry.regressed)) {
      const sliceSign = slice.delta > 0 ? "+" : "";
      lines.push(
        `  └─ ${slice.scenario}: ${fixed({ value: slice.baseline })} -> ${fixed({ value: slice.candidate })} ` +
          `(${sliceSign}${fixed({ value: slice.delta })})`,
      );
    }
  }
  lines.push("");
  lines.push(
    report.pass
      ? `Verdict: pass (${report.rows.length} metric(s), no regression beyond tolerance)`
      : `Verdict: FAIL: ${report.regressions.map((row) => row.metric).join(", ")} regressed`,
  );
  if (toleranceNote) lines.push(toleranceNote);
  return lines.join("\n");
}

export function fixed({ value }) {
  return value.toFixed(4);
}

export function parseTolerances({ value }) {
  const tolerances = {};
  for (const pair of value.split(",")) {
    const [metric, rawTolerance] = pair.split("=");
    if (!metric || rawTolerance === undefined) {
      throw new Error(`--tolerance expects metric=value pairs, got "${pair}"`);
    }
    const parsed = Number(rawTolerance);
    if (!Number.isFinite(parsed)) throw new Error(`tolerance for ${metric} is not a number`);
    tolerances[metric.trim()] = parsed;
  }
  return tolerances;
}

export function parseArgs({ argv }) {
  const options = { format: "text", defaultTolerance: 0.01, lowerIsBetter: LOWER_IS_BETTER };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (argv[index] === undefined) throw new Error(`${arg} needs a value`);
      return argv[index];
    };
    if (arg === "--baseline") options.baseline = next();
    else if (arg === "--candidate") options.candidate = next();
    else if (arg === "--format") options.format = next();
    else if (arg === "--tolerance") options.tolerances = parseTolerances({ value: next() });
    else if (arg === "--default-tolerance") options.defaultTolerance = Number(next());
    else if (arg === "--lower-is-better") options.lowerIsBetter = next().split(",").map((entry) => entry.trim());
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

export const USAGE = `Usage: node dev/scripts/eval-regression-gate/eval-regression-gate.mjs \\
  --baseline <export.json> --candidate <export.json> [options]

Options:
  --format text|json|markdown  output format (default: text)
  --tolerance m=v,m=v          absolute tolerance per metric, e.g. faithfulness=0.02
  --default-tolerance <n>      tolerance for metrics without an entry (default: 0.01)
  --lower-is-better <a,b>      metrics where a smaller value is better
                               (default: ${LOWER_IS_BETTER.join(",")})
  --help                       show this message

Exit codes: 0 pass, 1 regression, 2 unusable input.`;

export function main({ argv = process.argv.slice(2) } = {}) {
  let options;
  try {
    options = parseArgs({ argv });
  } catch (error) {
    console.error(`error: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (!options.baseline || !options.candidate) {
    console.error(`error: --baseline and --candidate are both required\n\n${USAGE}`);
    return 2;
  }

  try {
    const baseline = loadRuns({ path: options.baseline });
    const candidate = loadRuns({ path: options.candidate });
    const report = compareRuns({ ...options, baseline, candidate });
    const toleranceNote = `tolerances: default ${options.defaultTolerance}, overrides ${JSON.stringify(options.tolerances ?? {})}`;
    console.log(formatReport({ report, format: options.format, toleranceNote }));
    return report.pass ? 0 : 1;
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll("\\", "/")}`).href) {
  process.exit(main());
}
