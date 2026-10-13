#!/usr/bin/env node
// The `fausth` command always runs the current TypeScript sources (via tsx), so it can never
// execute a stale build. Library consumers use `main`/`types` from `pnpm build` (dist/).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsx = import.meta.resolve("tsx");
const r = spawnSync(process.execPath, ["--import", tsx, cli, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
