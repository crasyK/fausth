// The replay host (spec §14): answers a run from a fixture's recorded files. Browser-safe: it
// takes the files' texts; `node.ts` reads them from a directory.
import { InfraFailure, run, type Host, type Interrupt } from "./engine.js";
import { harnessErrors, readHarness, type Harness } from "./harness.js";
import { canonical } from "./values.js";

/** A fixture's input files as text; the recorded ones are optional. */
export interface FixtureFiles {
  harness: string;
  model?: string;
  tools?: string;
  user?: string;
  interrupts?: string;
  reloads?: string;
}

type Line = { [member: string]: unknown };

const lines = (text = ""): Line[] => text.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Line);

/** Replay a fixture; returns the log and the rendered requests as JSON Lines. */
export async function replayFiles(files: FixtureFiles): Promise<{ log: string; requests: string }> {
  const harness = readHarness(files.harness);
  const errors = harnessErrors(harness);
  if (errors.length > 0) throw new Error(`invalid harness: ${errors.join("; ")}`);
  const model = lines(files.model);
  const tools = lines(files.tools);
  const user = lines(files.user);
  const pending = lines(files.interrupts);
  const reloads = lines(files.reloads);
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
