// Command line: `replay <fixture dir>... [--write]` compares a replay with the expected files, or
// (with --write) writes them.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { replayDir } from "./node.js";

async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (command !== "replay") {
    console.error("usage: cli.ts replay <fixture dir>... [--write]");
    return 2;
  }
  const write = rest.includes("--write");
  let failed = 0;
  for (const dir of rest.filter((a) => a !== "--write")) {
    const out = await replayDir(dir);
    for (const [name, text] of [["expected.log.jsonl", out.log], ["expected.requests.jsonl", out.requests]] as const) {
      const path = join(dir, name);
      if (write) writeFileSync(path, text);
      else if (readFileSync(path, "utf8") !== text) {
        console.error(`${path}: differs`);
        failed += 1;
      }
    }
  }
  return failed === 0 ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
