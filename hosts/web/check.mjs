// Opens dist/index.html#replay in headless Chrome and fails unless every fixture replays to its
// expected files. CHROME names the browser binary (default: google-chrome).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const page = new URL("dist/index.html#replay", import.meta.url).href;
const dom = execFileSync(process.env.CHROME ?? "google-chrome",
  ["--headless=new", "--no-sandbox", "--disable-gpu", "--virtual-time-budget=60000", "--dump-dom", page],
  { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] });
const summary = /<p id="replay-summary"[^>]*>(\d+)\/(\d+) fixtures/.exec(dom);
if (!summary) {
  console.error(`no replay summary in ${fileURLToPath(page.split("#")[0])}`);
  process.exit(1);
}
console.log(`browser replay: ${summary[1]}/${summary[2]} fixtures match`);
process.exit(summary[1] === summary[2] ? 0 : 1);
