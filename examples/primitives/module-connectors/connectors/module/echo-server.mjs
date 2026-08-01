#!/usr/bin/env node
/**
 * Toy module stdio server: one JSON line in `{tool, args}` → `{output}` or `{error}`.
 */
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.tool === "echo.ping") {
      const echo = String(msg.args?.message ?? "pong");
      process.stdout.write(JSON.stringify({ output: { ok: 1, echo } }) + "\n");
      return;
    }
    process.stdout.write(JSON.stringify({ error: `unknown tool ${msg.tool}` }) + "\n");
  } catch (e) {
    process.stdout.write(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) + "\n",
    );
  }
});
