// Node-only helpers: reading a fixture directory for the replay host.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { replayFiles, type FixtureFiles } from "./replay.js";

const NAMES = ["model", "tools", "user", "interrupts", "reloads"] as const;

export function readFixture(dir: string): FixtureFiles {
  const files: FixtureFiles = { harness: readFileSync(join(dir, "harness.json"), "utf8") };
  for (const name of NAMES) {
    const path = join(dir, `${name}.jsonl`);
    if (existsSync(path)) files[name] = readFileSync(path, "utf8");
  }
  return files;
}

/** Replay a fixture directory; returns the log and the rendered requests as JSON Lines. */
export function replayDir(dir: string): Promise<{ log: string; requests: string }> {
  return replayFiles(readFixture(dir));
}
