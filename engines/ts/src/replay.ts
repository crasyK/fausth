// The replay host (spec §14): answers a run from a fixture's recorded files.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { InfraFailure, run, type Host, type Interrupt } from "./engine.js";
import { harnessErrors, readHarness, type Harness } from "./harness.js";
import { canonical } from "./values.js";

type Line = { [member: string]: unknown };

function lines(dir: string, name: string): Line[] {
  const path = join(dir, name);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Line);
}

/** Replay a fixture directory; returns the log and the rendered requests as JSON Lines. */
export async function replay(dir: string): Promise<{ log: string; requests: string }> {
  const harness = readHarness(readFileSync(join(dir, "harness.json"), "utf8"));
  const errors = harnessErrors(harness);
  if (errors.length > 0) throw new Error(`${dir}: invalid harness: ${errors.join("; ")}`);
  const model = lines(dir, "model.jsonl");
  const tools = lines(dir, "tools.jsonl");
  const user = lines(dir, "user.jsonl");
  const pending = lines(dir, "interrupts.jsonl");
  const reloads = lines(dir, "reloads.jsonl");
  const requests: string[] = [];

  const host: Host = {
    async user() {
      const line = user.shift();
      return line === undefined ? null : (line.text as string);
    },
    async model(request) {
      requests.push(`${canonical(request)}\n`);
      const line = model.shift();
      if (line === undefined) throw new InfraFailure("model.jsonl has no more responses");
      if ("error" in line) throw new InfraFailure(String(line.error));
      return line;
    },
    async call(id) {
      const line = tools.shift();
      if (line === undefined || line.id !== id || line.unreachable === true) {
        throw new InfraFailure(`tools.jsonl has no answer for ${id}`);
      }
      const { id: _, ...answer } = line;
      return answer;
    },
    interrupts(step) {
      const due: Interrupt[] = [];
      for (let i = 0; i < pending.length; ) {
        const line = pending[i]!;
        if ((line.step as number) <= step) {
          due.push({ source: line.source as string, text: line.text as string });
          pending.splice(i, 1);
        } else i += 1;
      }
      return due;
    },
    harness(step) {
      const line = reloads[0];
      if (line === undefined || (line.step as number) > step) return null;
      reloads.shift();
      return line.harness;
    },
  };
  const log = await run(harness as unknown as Harness, host);
  return { log: log.text(), requests: requests.join("") };
}
