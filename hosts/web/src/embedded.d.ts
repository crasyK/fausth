// Data the build embeds into the page (build.mjs).
declare module "embedded:fixtures" {
  import type { FixtureFiles } from "../../../engines/ts/src/replay.js";
  const fixtures: Record<string, FixtureFiles & { expected_log: string; expected_requests: string }>;
  export default fixtures;
}

declare module "embedded:chess-harness" {
  const text: string;
  export default text;
}
