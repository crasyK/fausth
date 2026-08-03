#!/usr/bin/env node
/** Run `fausth test --skip-fixtures` across the example library. */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const harnesses = [
  "examples/coding-counterbalance",
  "examples/support-bot",
  "examples/support-bot-ask",
  "examples/coding-bandwidth-terse",
  "examples/coding-bandwidth-verbose",
  "examples/greenhouse",
  "examples/mutable-skills",
];

let failed = 0;
for (const h of harnesses) {
  try {
    execFileSync(
      "pnpm",
      ["-C", "engines/ts", "exec", "node", "--import", "tsx", "src/cli.ts", "test", `../../${h}`, "--skip-fixtures"],
      { cwd: root, stdio: "inherit" },
    );
    console.log(`OK ${h}`);
  } catch {
    console.error(`FAIL ${h}`);
    failed += 1;
  }
}
if (failed) process.exit(1);
console.log(`harness-library-smoke ok (${harnesses.length - failed}/${harnesses.length})`);
