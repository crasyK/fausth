/**
 * Deterministic connector resolution (M10): compile/link sidecar manifests
 * into ResolvedHarnessIR without network access or module execution.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { canonicalJson } from "../canonical.js";
import { loadAgentDir } from "../load.js";
import type {
  AgentIR,
  ConnectorProvision,
  ConnectorSource,
  ConnectorsFile,
  ResolvedConnectorEntry,
  ResolvedConnectorLockEntry,
  ResolvedHarnessIR,
  ToolDef,
} from "../types.js";

export const CONNECTORS_FORMAT = "fausth-connectors/v0.1";
export const CONNECTOR_MANIFEST_FORMAT = "fausth-connector-manifest/v0.1";
export const MCP_DESCRIPTOR_FORMAT = "fausth-mcp-descriptor/v0.1";
export const RESOLVED_HARNESS_FORMAT = "fausth-resolved-harness/v0.1";

export type ConnectorErrorCode =
  | "connectors_invalid"
  | "connectors_path"
  | "connectors_hash_mismatch"
  | "connectors_duplicate"
  | "connectors_unknown_select"
  | "connectors_secret"
  | "connectors_unsupported";

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  constructor(code: ConnectorErrorCode, message: string) {
    super(message);
    this.name = "ConnectorError";
    this.code = code;
  }
}

const SECRET_KEY_RE = /(api[_-]?key|secret|password|token|credential|authorization)/i;

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function assertNoSecrets(value: unknown, path: string): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecrets(v, `${path}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(k)) {
      throw new ConnectorError(
        "connectors_secret",
        `forbidden secret-like key '${k}' at ${path}.${k}`,
      );
    }
    assertNoSecrets(v, `${path}.${k}`);
  }
}

function assertSafeRelativePath(relPath: string): void {
  if (!relPath || typeof relPath !== "string") {
    throw new ConnectorError("connectors_path", "empty connector path");
  }
  if (relPath.includes("\0")) {
    throw new ConnectorError("connectors_path", "connector path contains NUL");
  }
  if (isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath) || relPath.startsWith("~")) {
    throw new ConnectorError("connectors_path", `absolute connector path forbidden: ${relPath}`);
  }
  const norm = normalize(relPath).replace(/\\/g, "/");
  if (norm.startsWith("../") || norm === ".." || norm.split("/").includes("..")) {
    throw new ConnectorError("connectors_path", `path traversal forbidden: ${relPath}`);
  }
}

function resolveUnderHarness(harnessDir: string, relPath: string): { abs: string; rel: string } {
  assertSafeRelativePath(relPath);
  const abs = resolve(harnessDir, relPath);
  const rootReal = realpathSync(harnessDir);
  if (!existsSync(abs)) {
    throw new ConnectorError("connectors_path", `connector file not found: ${relPath}`);
  }
  if (lstatSync(abs).isSymbolicLink()) {
    // Allow symlink only if the real target stays inside the harness.
  }
  const fileReal = realpathSync(abs);
  const rel = relative(rootReal, fileReal);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new ConnectorError(
      "connectors_path",
      `connector path escapes harness root: ${relPath}`,
    );
  }
  return { abs: fileReal, rel: rel.split(sep).join("/") };
}

function loadYamlOrJson(path: string): unknown {
  const text = readFileSync(path, "utf8");
  if (path.endsWith(".json")) {
    return JSON.parse(text);
  }
  return parseYaml(text);
}

function asProvision(raw: unknown, path: string): ConnectorProvision {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConnectorError("connectors_invalid", `${path} must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  assertNoSecrets(obj, path);
  if (typeof obj.id !== "string" || !obj.id) {
    throw new ConnectorError("connectors_invalid", `${path}.id must be a non-empty string`);
  }
  const p: ConnectorProvision = { id: obj.id };
  if (obj.description !== undefined) p.description = String(obj.description);
  if (obj.read_only !== undefined) p.read_only = Boolean(obj.read_only);
  if (obj.input !== undefined) p.input = obj.input as Record<string, unknown>;
  if (obj.output !== undefined) p.output = obj.output as Record<string, unknown>;
  if (obj.verify !== undefined) p.verify = obj.verify as ConnectorProvision["verify"];
  if (obj.mcp_tool !== undefined) {
    if (typeof obj.mcp_tool !== "string" || !obj.mcp_tool) {
      throw new ConnectorError("connectors_invalid", `${path}.mcp_tool must be a non-empty string`);
    }
    p.mcp_tool = obj.mcp_tool;
  }
  return p;
}

function provisionToTool(p: ConnectorProvision): ToolDef {
  const t: ToolDef = { id: p.id };
  if (p.description !== undefined) t.description = p.description;
  if (p.read_only !== undefined) t.read_only = p.read_only;
  if (p.input !== undefined) t.input = p.input;
  if (p.output !== undefined) t.output = p.output;
  if (p.verify !== undefined) t.verify = p.verify;
  // mcp_tool is link metadata only — not part of AgentIR ToolDef
  return t;
}

function loadMcpDescriptor(
  harnessDir: string,
  connector: Extract<ConnectorSource, { kind: "mcp" }>,
): { provides: ConnectorProvision[]; sha256: string; path: string } {
  const { abs, rel } = resolveUnderHarness(harnessDir, connector.descriptor);
  if (!abs.endsWith(".json")) {
    throw new ConnectorError(
      "connectors_invalid",
      `mcp descriptor must be JSON (.json): ${rel}`,
    );
  }
  const content = readFileSync(abs, "utf8");
  const digest = sha256Hex(content);
  if (connector.sha256 !== undefined) {
    const expected = String(connector.sha256);
    if (!/^[a-f0-9]{64}$/.test(expected)) {
      throw new ConnectorError(
        "connectors_invalid",
        `connector '${connector.id}' sha256 must be a 64-char lowercase hex string`,
      );
    }
    if (expected !== digest) {
      throw new ConnectorError(
        "connectors_hash_mismatch",
        `sha256 mismatch for connector '${connector.id}' at ${rel}: expected ${expected}, got ${digest}`,
      );
    }
  }
  const raw = JSON.parse(content);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConnectorError("connectors_invalid", `mcp descriptor at ${rel} must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  if (obj.format !== MCP_DESCRIPTOR_FORMAT) {
    throw new ConnectorError(
      "connectors_unsupported",
      `unsupported mcp descriptor format at ${rel}: ${String(obj.format)}`,
    );
  }
  assertNoSecrets(obj, `mcp:${rel}`);
  if (!Array.isArray(obj.provides) || obj.provides.length === 0) {
    throw new ConnectorError("connectors_invalid", `mcp descriptor at ${rel} requires provides[]`);
  }
  const provides = obj.provides.map((p, i) => asProvision(p, `mcp:${rel}.provides[${i}]`));
  return { provides, sha256: digest, path: rel };
}

function loadFileManifest(
  harnessDir: string,
  connector: Extract<ConnectorSource, { kind: "file" }>,
): { provides: ConnectorProvision[]; sha256: string; path: string } {
  const { abs, rel } = resolveUnderHarness(harnessDir, connector.path);
  const content = readFileSync(abs, "utf8");
  const digest = sha256Hex(content);
  if (connector.sha256 !== undefined) {
    const expected = String(connector.sha256);
    if (!/^[a-f0-9]{64}$/.test(expected)) {
      throw new ConnectorError(
        "connectors_invalid",
        `connector '${connector.id}' sha256 must be a 64-char lowercase hex string`,
      );
    }
    if (expected !== digest) {
      throw new ConnectorError(
        "connectors_hash_mismatch",
        `sha256 mismatch for connector '${connector.id}' at ${rel}: expected ${expected}, got ${digest}`,
      );
    }
  }
  const raw = abs.endsWith(".json") ? JSON.parse(content) : parseYaml(content);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConnectorError("connectors_invalid", `manifest at ${rel} must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  if (obj.format !== CONNECTOR_MANIFEST_FORMAT) {
    throw new ConnectorError(
      "connectors_unsupported",
      `unsupported connector manifest format at ${rel}: ${String(obj.format)}`,
    );
  }
  assertNoSecrets(obj, `file:${rel}`);
  if (!Array.isArray(obj.provides) || obj.provides.length === 0) {
    throw new ConnectorError("connectors_invalid", `manifest at ${rel} requires provides[]`);
  }
  const provides = obj.provides.map((p, i) => asProvision(p, `file:${rel}.provides[${i}]`));
  return { provides, sha256: digest, path: rel };
}

function loadConnectorsFile(harnessDir: string): ConnectorsFile | null {
  for (const name of ["connectors.yml", "connectors.yaml", "connectors.json"]) {
    const p = join(harnessDir, name);
    if (!existsSync(p)) continue;
    const raw = loadYamlOrJson(p);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ConnectorError("connectors_invalid", `${name} must be an object`);
    }
    const obj = raw as Record<string, unknown>;
    if (obj.format !== CONNECTORS_FORMAT) {
      throw new ConnectorError(
        "connectors_unsupported",
        `unsupported connectors format: ${String(obj.format)}`,
      );
    }
    assertNoSecrets(obj, name);
    if (!Array.isArray(obj.connectors)) {
      throw new ConnectorError("connectors_invalid", `${name}.connectors must be an array`);
    }
    return obj as ConnectorsFile;
  }
  return null;
}

function selectProvides(
  connectorId: string,
  provides: ConnectorProvision[],
  select: string[] | undefined,
): ConnectorProvision[] {
  const ids = provides.map((p) => p.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) {
    throw new ConnectorError(
      "connectors_duplicate",
      `duplicate provision id '${dup}' in connector '${connectorId}'`,
    );
  }
  if (!select) return [...provides];
  const byId = new Map(provides.map((p) => [p.id, p]));
  const out: ConnectorProvision[] = [];
  for (const id of select) {
    const hit = byId.get(id);
    if (!hit) {
      throw new ConnectorError(
        "connectors_unknown_select",
        `connector '${connectorId}' select unknown provision '${id}'`,
      );
    }
    out.push(hit);
  }
  return out;
}

function mergeTools(agent: AgentIR, selected: ConnectorProvision[]): AgentIR {
  const tools = [...agent.tools];
  const byId = new Map(tools.map((t) => [t.id, t]));
  for (const p of selected) {
    const tool = provisionToTool(p);
    const existing = byId.get(tool.id);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(tool)) {
        throw new ConnectorError(
          "connectors_duplicate",
          `provision '${tool.id}' conflicts with existing agent tool definition`,
        );
      }
      continue;
    }
    tools.push(tool);
    byId.set(tool.id, tool);
  }
  return { ...agent, tools };
}

function emptyResolution(): ResolvedHarnessIR["resolution"] {
  return { connectors: [], selected: [], lock: [] };
}

/**
 * Resolve a harness directory into canonical ResolvedHarnessIR.
 * Identity passthrough when connectors.yml is absent.
 */
export function resolveHarness(harnessDir: string): ResolvedHarnessIR {
  const dir = resolve(harnessDir);
  const { agent } = loadAgentDir(dir);
  const source = loadConnectorsFile(dir);
  if (!source) {
    return {
      format: RESOLVED_HARNESS_FORMAT,
      agent,
      resolution: emptyResolution(),
    };
  }

  const connectorIds = new Set<string>();
  const entries: ResolvedConnectorEntry[] = [];
  const lock: ResolvedConnectorLockEntry[] = [];
  const selectedProvisions: ConnectorProvision[] = [];
  const selectedIds: string[] = [];
  const selectedSeen = new Set<string>();

  for (const raw of source.connectors) {
    if (!raw || typeof raw !== "object") {
      throw new ConnectorError("connectors_invalid", "connector entry must be an object");
    }
    const c = raw as ConnectorSource;
    if (typeof c.id !== "string" || !c.id) {
      throw new ConnectorError("connectors_invalid", "connector.id must be a non-empty string");
    }
    if (connectorIds.has(c.id)) {
      throw new ConnectorError("connectors_duplicate", `duplicate connector id '${c.id}'`);
    }
    connectorIds.add(c.id);

    if (c.kind === "inline") {
      assertNoSecrets(c, `connector:${c.id}`);
      if (!Array.isArray(c.provides) || c.provides.length === 0) {
        throw new ConnectorError(
          "connectors_invalid",
          `inline connector '${c.id}' requires provides[]`,
        );
      }
      const provides = c.provides.map((p, i) => asProvision(p, `connector:${c.id}.provides[${i}]`));
      const selected = selectProvides(c.id, provides, c.select);
      const digest = sha256Hex(canonicalJson({ kind: "inline", provides }));
      entries.push({
        id: c.id,
        kind: "inline",
        sha256: digest,
        provides: provides.map((p) => p.id).sort(),
        selected: selected.map((p) => p.id).sort(),
      });
      lock.push({ connector: c.id, kind: "inline", sha256: digest });
      for (const p of selected) {
        if (selectedSeen.has(p.id)) {
          throw new ConnectorError(
            "connectors_duplicate",
            `selected provision '${p.id}' provided by multiple connectors`,
          );
        }
        selectedSeen.add(p.id);
        selectedProvisions.push(p);
        selectedIds.push(p.id);
      }
      continue;
    }

    if (c.kind === "file") {
      assertNoSecrets(c, `connector:${c.id}`);
      if (typeof c.path !== "string" || !c.path) {
        throw new ConnectorError(
          "connectors_invalid",
          `file connector '${c.id}' requires path`,
        );
      }
      const loaded = loadFileManifest(dir, c);
      const selected = selectProvides(c.id, loaded.provides, c.select);
      entries.push({
        id: c.id,
        kind: "file",
        path: loaded.path,
        sha256: loaded.sha256,
        provides: loaded.provides.map((p) => p.id).sort(),
        selected: selected.map((p) => p.id).sort(),
      });
      lock.push({
        connector: c.id,
        kind: "file",
        path: loaded.path,
        sha256: loaded.sha256,
      });
      for (const p of selected) {
        if (selectedSeen.has(p.id)) {
          throw new ConnectorError(
            "connectors_duplicate",
            `selected provision '${p.id}' provided by multiple connectors`,
          );
        }
        selectedSeen.add(p.id);
        selectedProvisions.push(p);
        selectedIds.push(p.id);
      }
      continue;
    }

    if (c.kind === "mcp") {
      assertNoSecrets(c, `connector:${c.id}`);
      if (typeof c.descriptor !== "string" || !c.descriptor) {
        throw new ConnectorError(
          "connectors_invalid",
          `mcp connector '${c.id}' requires descriptor`,
        );
      }
      const loaded = loadMcpDescriptor(dir, c);
      const selected = selectProvides(c.id, loaded.provides, c.select);
      const mcp_tools: Record<string, string> = {};
      for (const p of loaded.provides) {
        mcp_tools[p.id] = p.mcp_tool ?? p.id;
      }
      // Stable key order for canonical JSON
      const orderedMcpTools = Object.fromEntries(
        Object.keys(mcp_tools)
          .sort()
          .map((k) => [k, mcp_tools[k]!]),
      );
      entries.push({
        id: c.id,
        kind: "mcp",
        path: loaded.path,
        sha256: loaded.sha256,
        provides: loaded.provides.map((p) => p.id).sort(),
        selected: selected.map((p) => p.id).sort(),
        mcp_tools: orderedMcpTools,
      });
      lock.push({
        connector: c.id,
        kind: "mcp",
        path: loaded.path,
        sha256: loaded.sha256,
      });
      for (const p of selected) {
        if (selectedSeen.has(p.id)) {
          throw new ConnectorError(
            "connectors_duplicate",
            `selected provision '${p.id}' provided by multiple connectors`,
          );
        }
        selectedSeen.add(p.id);
        selectedProvisions.push(p);
        selectedIds.push(p.id);
      }
      continue;
    }

    if (c.kind === "module") {
      throw new ConnectorError(
        "connectors_unsupported",
        `unsupported connector kind 'module' (deferred; use mcp|inline|file)`,
      );
    }

    throw new ConnectorError(
      "connectors_unsupported",
      `unsupported connector kind '${String((c as { kind?: string }).kind)}' (supports inline|file|mcp)`,
    );
  }

  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  lock.sort((a, b) => (a.connector < b.connector ? -1 : a.connector > b.connector ? 1 : 0));
  selectedIds.sort();

  const merged = mergeTools(agent, selectedProvisions);
  return {
    format: RESOLVED_HARNESS_FORMAT,
    agent: merged,
    resolution: {
      connectors: entries,
      selected: selectedIds,
      lock,
    },
  };
}

/** Canonical JSON bytes for ResolvedHarnessIR (byte-identical across engines). */
export function resolvedHarnessCanonicalJson(resolved: ResolvedHarnessIR): string {
  return canonicalJson(resolved) + "\n";
}

export function resolvedHarnessHash(resolved: ResolvedHarnessIR): string {
  return sha256Hex(canonicalJson(resolved));
}
