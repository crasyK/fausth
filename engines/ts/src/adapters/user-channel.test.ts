/**
 * D14 / EDGE-19: the User cell answers from recorded answers, a declared simulator, or a
 * human — never from the acting model's own arguments.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentIR, Deployment, ToolDef, ToolResultEnvelope } from "../types.js";
import type { ModelPort, ModelProposeRequest } from "../model/port.js";
import { AdapterError } from "./error.js";
import { bindToolsFromDeployment } from "./registry.js";
import {
  coerceHumanAnswer,
  createUserChannelHandler,
  parseSimulatorReply,
  parseUserChannelBinding,
  type UserTranscriptEntry,
} from "./user-channel.js";

const askTool: ToolDef = {
  id: "user.ask",
  description: "Ask the user a clarifying question",
  input: { type: "object", additionalProperties: true, properties: { question: { type: "string" } } },
  output: {
    type: "object",
    required: ["answer"],
    additionalProperties: false,
    properties: { answer: { type: "string" } },
  },
};

const deployment: Deployment = { model: { transport: "recorded" }, bindings: {} };

class FakePort implements ModelPort {
  lastModelUsed = "fake";
  requests: ModelProposeRequest[] = [];
  constructor(private replies: string[]) {}
  async propose(input: ModelProposeRequest) {
    this.requests.push(structuredClone(input));
    const message = this.replies.shift() ?? "";
    return { type: "stop" as const, message };
  }
}

describe("user channel", () => {
  let dir = "";
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "fausth-user-"));
    writeFileSync(
      join(dir, "answers.jsonl"),
      [
        { tool: "user.ask", call_seq: 2, result: { output: { answer: "second" } } },
        {
          tool: "user.ask",
          args: { question: "refund or replacement?" },
          result: { output: { answer: "replacement" }, state_transition: { set: { clarified: 1 } } },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );
    writeFileSync(join(dir, "persona.md"), "You are Ada, a customer.");
    writeFileSync(join(dir, "hidden.md"), "SECRET-GOAL: you want a replacement, order #W42.");
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("recorded: exact match returns the recorded envelope; a missing answer is a user-channel failure", async () => {
    const transcript: UserTranscriptEntry[] = [];
    const h = createUserChannelHandler(askTool, parseUserChannelBinding("user.ask", { source: "recorded", answers: "answers.jsonl" }), {
      baseDir: dir,
      deployment,
      transcript,
    });
    const first = (await h({ question: "refund or replacement?" }, { state: {} })) as ToolResultEnvelope;
    assert.deepEqual(first, { output: { answer: "replacement" }, state_transition: { set: { clarified: 1 } } });
    const second = (await h({ question: "anything" }, { state: {} })) as ToolResultEnvelope;
    assert.deepEqual(second, { output: { answer: "second" } });
    await assert.rejects(
      async () => h({ question: "third" }, { state: {} }),
      (e: unknown) => e instanceof AdapterError && e.code === "user_channel_unavailable",
    );
    assert.equal(transcript.length, 2);
    assert.equal(transcript[0]!.source, "recorded");
  });

  it("recorded: a model-supplied 'answer' arg is never echoed back", async () => {
    const h = createUserChannelHandler(askTool, parseUserChannelBinding("user.ask", { source: "recorded", answers: "answers.jsonl" }), {
      baseDir: dir,
      deployment,
    });
    await assert.rejects(
      async () => h({ question: "refund or replacement?", answer: "yes, do it" }, { state: {} }),
      (e: unknown) => e instanceof AdapterError && e.code === "user_channel_unavailable",
    );
  });

  it("recorded: answers path must stay inside the base directory", () => {
    assert.throws(() =>
      createUserChannelHandler(askTool, parseUserChannelBinding("user.ask", { source: "recorded", answers: "../etc/passwd" }), {
        baseDir: dir,
        deployment,
      }),
    );
    assert.throws(() =>
      createUserChannelHandler(askTool, parseUserChannelBinding("user.ask", { source: "recorded", answers: "/etc/passwd" }), {
        baseDir: dir,
        deployment,
      }),
    );
  });

  it("simulator: hidden context reaches only the simulator; output is schema-checked with one retry; transcript recorded", async () => {
    const port = new FakePort(["I think so", '{"output":{"answer":"a replacement please"}}']);
    const transcript: UserTranscriptEntry[] = [];
    const h = createUserChannelHandler(
      askTool,
      parseUserChannelBinding("user.ask", {
        source: "simulator",
        model: "kit.glm-5.3-flash",
        system_prompt_file: "persona.md",
        context_file: "hidden.md",
      }),
      { baseDir: dir, deployment, transcript, simulatorPort: () => port },
    );
    const r = (await h({ question: "refund or replacement?" }, { state: {} })) as ToolResultEnvelope;
    assert.deepEqual(r, { output: { answer: "a replacement please" } });
    const system = port.requests[0]!.messages[0]!.content ?? "";
    assert.match(system, /SECRET-GOAL/);
    assert.match(system, /Ada/);
    assert.deepEqual(port.requests[0]!.tools, []);
    assert.equal(port.requests.length, 2, "one retry after an unusable reply");
    assert.equal(transcript[0]!.simulator?.responses.length, 2);
    // The agent-facing result never contains the hidden context.
    assert.ok(!JSON.stringify(r).includes("SECRET-GOAL"));
  });

  it("simulator: state keys outside the checkpoint allowlist are rejected", () => {
    const bad = parseSimulatorReply('{"output":{"answer":"x"},"set":{"plan_approved":1}}', {
      output_schema: askTool.output,
      allow_set_keys: ["clarified"],
    });
    assert.equal(bad.ok, false);
    const ok = parseSimulatorReply('```json\n{"output":{"answer":"x"},"set":{"clarified":1}}\n```', {
      output_schema: askTool.output,
      allow_set_keys: ["clarified"],
    });
    assert.deepEqual(ok, { ok: true, answer: { output: { answer: "x" }, set: { clarified: 1 } } });
  });

  it("human: callback answers; non-interactive without callback is a user-channel failure", async () => {
    const h = createUserChannelHandler(askTool, parseUserChannelBinding("user.ask", { source: "human" }), {
      baseDir: dir,
      deployment,
      humanAnswer: async (req) => ({ output: { answer: `human saw ${String(req.args.question)}` } }),
    });
    assert.deepEqual(await h({ question: "q?" }, { state: {} }), { output: { answer: "human saw q?" } });
    if (!process.stdin.isTTY) {
      const tty = createUserChannelHandler(askTool, parseUserChannelBinding("user.ask", { source: "human" }), {
        baseDir: dir,
        deployment,
      });
      await assert.rejects(
        async () => tty({ question: "q?" }, { state: {} }),
        (e: unknown) => e instanceof AdapterError && e.code === "user_channel_unavailable",
      );
    }
    assert.deepEqual(coerceHumanAnswer("yes", { required: ["approved"], properties: { approved: { type: "integer" } } }), {
      output: { approved: 1 },
    });
    assert.equal(coerceHumanAnswer("maybe", { required: ["approved"], properties: { approved: { type: "integer" } } }), null);
  });

  it("binding validation: closed source set and required fields", () => {
    assert.throws(() => parseUserChannelBinding("user.ask", { source: "auto" }));
    assert.throws(() => parseUserChannelBinding("user.ask", { source: "recorded" }));
    assert.throws(() => parseUserChannelBinding("user.ask", { source: "simulator" }));
  });

  it("registry: user bindings bind; channel:user tools refuse native bindings and stay unbound when not bound", () => {
    const agent: AgentIR = {
      spec: "counterbalance-contract/v0.1",
      name: "u",
      state: {},
      tools: [
        { ...askTool, channel: "user" } as ToolDef,
        { id: "task.complete", input: { type: "object" }, output: { type: "object" } },
      ],
    };
    const bound = bindToolsFromDeployment(
      agent,
      {
        model: { transport: "recorded" },
        bindings: {
          "user.ask": { user: { source: "recorded", answers: "answers.jsonl" } },
          "task.complete": { native: "stub.task_complete" },
        } as unknown as Deployment["bindings"],
      },
      { harnessDir: dir },
    );
    assert.equal(typeof bound.tools["user.ask"], "function");
    const unbound = bindToolsFromDeployment(
      agent,
      { model: { transport: "recorded" }, bindings: { "task.complete": { native: "stub.task_complete" } } },
      { harnessDir: dir },
    );
    assert.equal(unbound.tools["user.ask"], undefined, "unbound user channel → capability missing");
    assert.throws(
      () =>
        bindToolsFromDeployment(
          agent,
          {
            model: { transport: "recorded" },
            bindings: {
              "user.ask": { native: "stub.task_complete" },
              "task.complete": { native: "stub.task_complete" },
            },
          },
          { harnessDir: dir },
        ),
      /channel user/,
    );
    assert.throws(
      () =>
        bindToolsFromDeployment(
          { ...agent, tools: [askTool] },
          { model: { transport: "recorded" }, bindings: { "user.ask": { native: "stub.ask" } } },
          { harnessDir: dir },
        ),
      /D14/,
    );
  });
});

describe("user channel state typing", () => {
  it("user-set values must match the IR state type and be canonical (D3)", async () => {
    const { checkUserSet } = await import("./user-channel.js");
    assert.equal(checkUserSet({ clarified: 1 }, ["clarified"], { clarified: "integer" }), null);
    assert.match(String(checkUserSet({ clarified: "wants_replacement" }, ["clarified"], { clarified: "integer" })), /integer/);
    assert.match(String(checkUserSet({ clarified: 0.5 }, ["clarified"], { clarified: "integer" })), /non-integral/);
    assert.match(String(checkUserSet({ other: 1 }, ["clarified"], {})), /may only contain/);
    const bad = parseSimulatorReply('{"output":{"answer":"x"},"set":{"clarified":"yes"}}', {
      output_schema: askTool.output,
      allow_set_keys: ["clarified"],
      state_types: { clarified: "integer" },
    });
    assert.equal(bad.ok, false);
  });
});
