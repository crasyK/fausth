#!/usr/bin/env node
/**
 * Minimal line-delimited JSON-RPC MCP server for live stdio smoke.
 * Implements initialize + tools/call for get_forecast only.
 */
import { createInterface } from "node:readline";

const FORECASTS = {
  Berlin: { summary: "sunny", temp_c: 22 },
};

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function fail(id, message) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }) + "\n",
  );
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const raw = line.trim();
  if (!raw) return;
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (method === "notifications/initialized" || method?.startsWith("notifications/")) {
    return;
  }
  if (method === "initialize") {
    reply(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "fausth-weather-toy", version: "0.1.0" },
    });
    return;
  }
  if (method === "tools/list") {
    reply(id, {
      tools: [
        {
          name: "get_forecast",
          description: "Toy weather forecast",
          inputSchema: {
            type: "object",
            properties: { city: { type: "string" } },
          },
        },
      ],
    });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (name !== "get_forecast") {
      fail(id, `unknown tool: ${name}`);
      return;
    }
    const city = typeof args.city === "string" ? args.city : "";
    const forecast = FORECASTS[city] ?? { summary: "unknown", temp_c: 0 };
    reply(id, {
      content: [{ type: "text", text: JSON.stringify(forecast) }],
      structuredContent: forecast,
    });
    return;
  }
  if (typeof id === "number") {
    fail(id, `unsupported method: ${method}`);
  }
});
