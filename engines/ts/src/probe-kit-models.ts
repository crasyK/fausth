/**
 * Probe each KIT model individually and write reports under live/reports/.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { probeProvider } from "./model/probe.js";
import type { Deployment } from "./types.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function loadDotEnv() {
  const path = join(root, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

const MODELS = [
  "kit.minimax-m2.7-229b",
  "kit.mistral-small-4-119b-a8b",
  "kit.qwen3.5-397b-A17b",
  "kit.gemma4-31b-it",
];

async function main() {
  loadDotEnv();
  const outDir = join(root, "live/reports");
  mkdirSync(outDir, { recursive: true });
  const summary: unknown[] = [];

  for (const model of MODELS) {
    console.log(`\n=== probing ${model} ===`);
    const deployment: Deployment = {
      model: {
        transport: "openai-compatible",
        profile: "kit-scc",
        base_url: "https://ki-toolbox.scc.kit.edu/api/v1",
        api_key_env: "KIT_AI_API_KEY",
        models: [model],
        temperature: 0,
        max_tokens: 512,
      },
      bindings: {},
    };
    const report = await probeProvider(deployment);
    const safeName = model.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = join(outDir, `kit-probe-${safeName}.json`);
    writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
    summary.push({ model, ...report });
  }

  writeFileSync(join(outDir, "kit-probe-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  const working = summary.filter(
    (s) => (s as { auth?: boolean; chat_completions?: boolean }).auth && (s as { chat_completions?: boolean }).chat_completions,
  );
  console.log(`\nWorking models: ${working.length}/${MODELS.length}`);
  for (const w of working) console.log(" -", (w as { model: string }).model);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
