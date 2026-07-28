import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd());

function readJson(path) {
  return JSON.parse(readFileSync(resolve(root, path), "utf8"));
}

function readText(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
}

function ok(msg) {
  console.log(`OK: ${msg}`);
}

function extractFausthRef(workflowPath) {
  const content = readText(workflowPath);
  const m = content.match(/repository:\s*crasyK\/fausth[\s\S]*?ref:\s*([0-9a-f]{40})/m);
  if (!m) {
    fail(`${workflowPath} is missing pinned crasyK/fausth ref`);
    return null;
  }
  return m[1];
}

const rootPkg = readJson("package.json");
const tsPkg = readJson("engines/ts/package.json");
const pyproject = readText("engines/py/pyproject.toml");
const pyInit = readText("engines/py/fausth/__init__.py");

if (rootPkg.version !== tsPkg.version) {
  fail(`root package version ${rootPkg.version} != TS package version ${tsPkg.version}`);
} else {
  ok(`root and TS versions match (${rootPkg.version})`);
}

const pyprojectMatch = pyproject.match(/^version\s*=\s*"([^"]+)"/m);
const pyInitMatch = pyInit.match(/^__version__\s*=\s*"([^"]+)"/m);
if (!pyprojectMatch || !pyInitMatch) {
  fail("could not parse Python versions");
} else if (pyprojectMatch[1] !== pyInitMatch[1]) {
  fail(`pyproject version ${pyprojectMatch[1]} != __init__ version ${pyInitMatch[1]}`);
} else {
  ok(`python versions match (${pyprojectMatch[1]})`);
}

const l1 = extractFausthRef("examples/slopathon-review/workflows/submission-deterministic.yml");
const l2 = extractFausthRef("examples/slopathon-review/workflows/submission-faust-review.yml");
if (l1 && l2) {
  if (l1 !== l2) {
    fail(`SLOPATHON workflow refs differ (${l1} vs ${l2})`);
  } else {
    ok(`SLOPATHON workflow refs aligned (${l1})`);
  }
}

if (process.exitCode) {
  console.error("release checks failed");
  process.exit(process.exitCode);
}

console.log("release checks passed");
