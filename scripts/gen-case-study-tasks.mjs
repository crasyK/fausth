#!/usr/bin/env node
/**
 * One-shot generator for coding case-study tasks + recorded model traces.
 * Run: node scripts/gen-case-study-tasks.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const tasks = [
  {
    id: "01-fix-add",
    title: "Fix add()",
    category: "bugfix",
    prompt:
      "The function add(a, b) in src/app.js is wrong. Use phase tools. Write the fix under src/, shell.run_allowlisted cmd=test, clear open todos via user.correct, then task.complete. Do not write before plan approval.",
    app: `export function add(a, b) {
  return a - b; // bug: should add
}
`,
    test: `import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { add } from "./app.js";

describe("add", () => {
  it("adds", () => assert.equal(add(2, 3), 5));
});
`,
    fixed: `export function add(a, b) {
  return a + b;
}
`,
  },
  {
    id: "02-add-multiply",
    title: "Add multiply()",
    category: "feature",
    prompt:
      "Add export function multiply(a, b) in src/app.js that returns a*b. Research, then plan+approve, then implement under src/, shell.run_allowlisted cmd=test, clear todos, complete. Do not write before plan approval.",
    app: `export function add(a, b) {
  return a + b;
}
`,
    test: `import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { multiply } from "./app.js";

describe("multiply", () => {
  it("multiplies", () => assert.equal(multiply(3, 4), 12));
});
`,
    fixed: `export function add(a, b) {
  return a + b;
}
export function multiply(a, b) {
  return a * b;
}
`,
  },
  {
    id: "03-fix-off-by-one",
    title: "Fix off-by-one sumTo",
    category: "bugfix",
    prompt:
      "sumTo(n) should sum 1..n inclusive but is off-by-one. Research, then plan+approve, then fix under src/, shell.run_allowlisted cmd=test, clear todos, complete. No write before approval.",
    app: `export function sumTo(n) {
  let s = 0;
  for (let i = 1; i < n; i++) s += i; // bug: misses n
  return s;
}
`,
    test: `import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sumTo } from "./app.js";

describe("sumTo", () => {
  it("sums 1..n", () => assert.equal(sumTo(4), 10));
});
`,
    fixed: `export function sumTo(n) {
  let s = 0;
  for (let i = 1; i <= n; i++) s += i;
  return s;
}
`,
  },
  {
    id: "04-add-clamp",
    title: "Add clamp()",
    category: "feature",
    prompt:
      "Implement export function clamp(n, min, max) in src/app.js. Research, then plan+approve, then write under src/, shell.run_allowlisted cmd=test, clear todos, complete.",
    app: `export function identity(x) {
  return x;
}
`,
    test: `import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clamp } from "./app.js";

describe("clamp", () => {
  it("clamps", () => {
    assert.equal(clamp(5, 0, 10), 5);
    assert.equal(clamp(-1, 0, 10), 0);
    assert.equal(clamp(99, 0, 10), 10);
  });
});
`,
    fixed: `export function identity(x) {
  return x;
}
export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}
`,
  },
  {
    id: "05-rename-greet",
    title: "Rename hello to greet",
    category: "refactor",
    prompt:
      "Rename export function hello to greet in src/app.js and keep behavior. Research, then plan+approve, then implement, shell.run_allowlisted cmd=test, clear todos, complete.",
    app: `export function hello(name) {
  return "hi " + name;
}
`,
    test: `import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { greet } from "./app.js";

describe("greet", () => {
  it("greets", () => assert.equal(greet("Ada"), "hi Ada"));
});
`,
    fixed: `export function greet(name) {
  return "hi " + name;
}
`,
  },
  {
    id: "06-fix-null-guard",
    title: "Guard null length",
    category: "bugfix",
    prompt:
      "len(s) throws on null/undefined. Return 0 instead. Research, then plan+approve, then fix under src/, shell.run_allowlisted cmd=test, clear todos, complete.",
    app: `export function len(s) {
  return s.length;
}
`,
    test: `import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { len } from "./app.js";

describe("len", () => {
  it("handles nullish", () => {
    assert.equal(len(null), 0);
    assert.equal(len(undefined), 0);
    assert.equal(len("ab"), 2);
  });
});
`,
    fixed: `export function len(s) {
  if (s == null) return 0;
  return s.length;
}
`,
  },
  {
    id: "07-extract-sum",
    title: "Extract sum helper",
    category: "refactor",
    prompt:
      "Extract export function sum(nums) used by total(). Keep total() working. Research, then plan+approve, then implement under src/, shell.run_allowlisted cmd=test, clear todos, complete.",
    app: `export function total(nums) {
  let s = 0;
  for (const n of nums) s += n;
  return s;
}
`,
    test: `import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sum, total } from "./app.js";

describe("sum/total", () => {
  it("sums", () => {
    assert.equal(sum([1, 2, 3]), 6);
    assert.equal(total([1, 2, 3]), 6);
  });
});
`,
    fixed: `export function sum(nums) {
  let s = 0;
  for (const n of nums) s += n;
  return s;
}
export function total(nums) {
  return sum(nums);
}
`,
  },
  {
    id: "08-add-avg",
    title: "Add average()",
    category: "feature",
    prompt:
      "Add export function average(nums) returning arithmetic mean (0 for empty). Research, then plan+approve, then implement under src/, shell.run_allowlisted cmd=test, clear todos, complete.",
    app: `export function sum(nums) {
  let s = 0;
  for (const n of nums) s += n;
  return s;
}
`,
    test: `import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { average } from "./app.js";

describe("average", () => {
  it("averages", () => {
    assert.equal(average([2, 4]), 3);
    assert.equal(average([]), 0);
  });
});
`,
    fixed: `export function sum(nums) {
  let s = 0;
  for (const n of nums) s += n;
  return s;
}
export function average(nums) {
  if (nums.length === 0) return 0;
  return sum(nums) / nums.length;
}
`,
  },
];

const tasksRoot = join(root, "case-studies/coding-counterbalance/tasks");
const recordedRoot = join(root, "case-studies/coding-counterbalance/recorded");

for (const t of tasks) {
  const dir = join(tasksRoot, t.id);
  const seed = join(dir, "seed");
  const src = join(seed, "src");
  const grade = join(dir, "grade");
  mkdirSync(src, { recursive: true });
  mkdirSync(grade, { recursive: true });
  writeFileSync(
    join(dir, "task.yml"),
    [
      `id: ${t.id}`,
      `title: ${JSON.stringify(t.title)}`,
      `category: ${t.category}`,
      "prompt_file: prompt.md",
      "seed_dir: seed",
      "grade_dir: grade",
      "verify:",
      "  test_command: test",
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, "prompt.md"), `${t.prompt}\n`);
  writeFileSync(join(src, "app.js"), t.app);
  writeFileSync(join(src, "app.test.js"), t.test);
  // Held-out grader: never copied into seed; runner copies into worktree after the agent stops.
  writeFileSync(join(grade, "app.grade.test.js"), t.test.replace('from "./app.js"', 'from "../src/app.js"'));
  writeFileSync(
    join(seed, "package.json"),
    JSON.stringify({ type: "module", name: `fausth-case-${t.id}` }, null, 2) + "\n",
  );

  const recorded = join(recordedRoot, t.id);
  mkdirSync(recorded, { recursive: true });
  const cb = [
    { type: "tool", name: "fs.read", args: { path: "src/app.js" } },
    { type: "tool", name: "user.approve", args: {} },
    { type: "tool", name: "fs.write_scoped", args: { path: "src/app.js", content: t.fixed } },
    { type: "tool", name: "shell.run_allowlisted", args: { cmd: "test" } },
    { type: "tool", name: "user.correct", args: { request: "mark todos resolved" } },
    { type: "tool", name: "task.complete", args: {} },
  ];
  // Permissive: write immediately (no plan), complete without clearing todos — plumbing only.
  const perm = [
    { type: "tool", name: "fs.read", args: { path: "src/app.js" } },
    { type: "tool", name: "fs.write_scoped", args: { path: "src/app.js", content: t.fixed } },
    { type: "tool", name: "shell.run_allowlisted", args: { cmd: "test" } },
    { type: "tool", name: "task.complete", args: {} },
  ];
  writeFileSync(join(recorded, "counterbalanced.model.jsonl"), cb.map((x) => JSON.stringify(x)).join("\n") + "\n");
  writeFileSync(
    join(recorded, "permissive-control.model.jsonl"),
    perm.map((x) => JSON.stringify(x)).join("\n") + "\n",
  );
}

console.log(`wrote ${tasks.length} tasks + grade tests + recorded traces`);
