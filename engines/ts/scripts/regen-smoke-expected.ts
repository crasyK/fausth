import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentDir, loadDeployment, readJsonl } from "../src/load.js";
import { parseRecordedModelLine } from "../src/adapters/recorded.js";
import { resolveToolsFromDeployment } from "../src/adapters/registry.js";
import { FaustRuntime, eventsToJsonl } from "../src/runtime.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

async function regen(rel: string) {
  const dir = join(root, rel);
  const { agent } = loadAgentDir(dir);
  const deployment = loadDeployment(join(dir, "deployment.fixture.yml"));
  const tools = resolveToolsFromDeployment(agent, deployment, { harnessDir: dir });
  const proposals = readJsonl(join(dir, "smoke.model.jsonl")).map(parseRecordedModelLine);
  let pi = 0;
  const rt = new FaustRuntime({
    agent,
    propose: async () => (pi >= proposals.length ? { type: "stop" } : proposals[pi++]),
    tools,
  });
  await rt.runLoop(32);
  writeFileSync(join(dir, "smoke.expected.jsonl"), eventsToJsonl(rt.events));
  console.log("wrote", rel);
}

for (const rel of ["examples/coding-counterbalance", "examples/support-bot"]) {
  await regen(rel);
}
