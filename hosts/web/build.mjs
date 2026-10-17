// Builds dist/index.html: one self-contained page with the TS engine, chess.js, the conformance
// fixtures and examples/chess/harness.yaml inlined.
import { build } from "esbuild";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const root = here("../../");
const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : undefined);

const fixtures = {};
for (const name of readdirSync(`${root}conformance/fixtures`).sort()) {
  const f = (file) => read(`${root}conformance/fixtures/${name}/${file}`);
  fixtures[name] = {
    harness: f("harness.json"), model: f("model.jsonl"), tools: f("tools.jsonl"), user: f("user.jsonl"),
    interrupts: f("interrupts.jsonl"), reloads: f("reloads.jsonl"),
    expected_log: f("expected.log.jsonl"), expected_requests: f("expected.requests.jsonl"),
  };
}
const embedded = { fixtures, "chess-harness": read(`${root}examples/chess/harness.yaml`) };

const result = await build({
  entryPoints: [here("src/page.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2023",
  minify: true,
  legalComments: "none",
  write: false,
  plugins: [{
    name: "embedded",
    setup(b) {
      b.onResolve({ filter: /^embedded:/ }, (a) => ({ path: a.path.slice("embedded:".length), namespace: "embedded" }));
      b.onLoad({ filter: /.*/, namespace: "embedded" }, (a) => ({ contents: JSON.stringify(embedded[a.path]), loader: "json" }));
    },
  }],
});
const script = result.outputFiles[0].text.replaceAll("</script", "<\\/script");
const html = readFileSync(here("index.html"), "utf8").replace("<!--SCRIPT-->", () => `<script>${script}</script>`);
mkdirSync(here("dist"), { recursive: true });
writeFileSync(here("dist/index.html"), html);
console.log(`dist/index.html: ${(html.length / 1024).toFixed(0)} KiB, ${Object.keys(fixtures).length} fixtures`);
