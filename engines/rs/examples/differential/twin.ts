// The TypeScript engine's side of the differential checks (run.sh): the same subcommands as differential.rs, except
// `numbers`, which reads Rust's lines and prints each double's ECMAScript form.
import { readFileSync } from "node:fs";
import { harnessErrors, readHarness } from "../../../ts/src/harness.ts";
import { compileSchema } from "../../../ts/src/schema.ts";
import { canonical } from "../../../ts/src/values.ts";

const [command, file] = process.argv.slice(2);
const lines = readFileSync(file!, "utf8").split("\n").filter(Boolean);
for (const line of lines) {
  if (command === "numbers") {
    const [bits] = line.split(" ");
    console.log(`${bits} ${String(Buffer.from(bits!, "hex").readDoubleBE(0))}`);
  } else if (command === "read") {
    let out: string;
    try {
      const v = readHarness(readFileSync(line, "utf8"));
      out = `${harnessErrors(v).length === 0 ? "valid" : "invalid"} ${canonical(v)}`;
    } catch {
      out = "error";
    }
    console.log(`${line}\t${out}`);
  } else {
    const [first, values] = JSON.parse(line) as [unknown, unknown[]];
    try {
      const check = compileSchema((command === "patterns" ? { pattern: first } : first) as object);
      console.log(values.map((v) => (check(v) ? "1" : "0")).join(""));
    } catch {
      console.log("error");
    }
  }
}
