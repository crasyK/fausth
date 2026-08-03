#!/usr/bin/env node
/**
 * Fausth Lab UI — thin orchestrator over existing CLIs.
 * Trusted LAN only unless FAUSTH_LAB_TOKEN is set.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.FAUSTH_ROOT || path.resolve(__dirname, '..');
const PORT = Number(process.env.FAUSTH_LAB_PORT || 8787);
const TOKEN = process.env.FAUSTH_LAB_TOKEN || '';
const PUBLIC = path.join(__dirname, 'public');
const RUNS_DIR = path.join(ROOT, 'live', 'reports', 'lab-ui');

/** @typedef {{ id: string, kind: string, worldId: string, cmd: string[], startedAt: string, status: string, exitCode: number|null, logPath: string }} Run */

/** @type {Map<string, Run & { child?: import('node:child_process').ChildProcess }>} */
const runs = new Map();

function loadWorlds() {
  const dir = path.join(ROOT, 'worlds');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const yml = path.join(dir, d.name, 'world.yml');
      if (!fs.existsSync(yml)) return null;
      const text = fs.readFileSync(yml, 'utf8');
      const id = matchField(text, 'id') || d.name;
      return {
        id,
        title: matchField(text, 'title') || id,
        status: matchField(text, 'status') || 'draft',
        summary: matchField(text, 'summary') || '',
        harness: matchField(text, 'harness') || '',
        track_a: matchField(text, 'track_a') || '',
        case_study_manifest: matchField(text, 'case_study_manifest') || '',
        path: `worlds/${d.name}`,
      };
    })
    .filter(Boolean);
}

function matchField(text, key) {
  const re = new RegExp(`^${key}:\\s*["']?([^"'\\n#]+)`, 'm');
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

function authorized(req, url) {
  if (!TOKEN) return true;
  const h = req.headers.authorization || '';
  if (h === `Bearer ${TOKEN}`) return true;
  if (url.searchParams.get('token') === TOKEN) return true;
  return false;
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

function ensureRunsDir() {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
}

/**
 * @param {string} kind
 * @param {string} worldId
 * @param {string[]} cmd
 */
function startRun(kind, worldId, cmd) {
  ensureRunsDir();
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const logPath = path.join(RUNS_DIR, `${id}.log`);
  const logFd = fs.openSync(logPath, 'w');
  const child = spawn(cmd[0], cmd.slice(1), {
    cwd: ROOT,
    env: { ...process.env, PATH: process.env.PATH },
    stdio: ['ignore', logFd, logFd],
    detached: false,
  });
  /** @type {Run & { child: import('node:child_process').ChildProcess }} */
  const run = {
    id,
    kind,
    worldId,
    cmd,
    startedAt: new Date().toISOString(),
    status: 'running',
    exitCode: null,
    logPath,
    child,
  };
  runs.set(id, run);
  child.on('exit', (code) => {
    run.status = code === 0 ? 'ok' : 'failed';
    run.exitCode = code;
    try {
      fs.closeSync(logFd);
    } catch {
      /* already closed */
    }
  });
  return run;
}

function listRuns() {
  return [...runs.values()].map(({ child: _c, ...r }) => r).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

function buildCmd(action, world) {
  if (action === 'track_a') {
    const target = world.track_a || world.harness;
    if (!target) throw new Error('world has no track_a / harness path');
    return ['pnpm', '-C', 'engines/ts', 'exec', 'node', '--import', 'tsx', 'src/cli.ts', 'test', path.join('../..', target), '--skip-fixtures'];
  }
  if (action === 'case_study_recorded') {
    const manifest = world.case_study_manifest;
    if (!manifest) throw new Error('world has no case_study_manifest');
    return [
      'node',
      'scripts/case-study-coding.mjs',
      '--manifest',
      manifest,
      '--mode',
      'recorded',
      '--skip-conformance',
      '--run-id',
      `lab-${world.id}-recorded`,
    ];
  }
  if (action === 'conformance') {
    return ['pnpm', 'ci:conformance'];
  }
  throw new Error(`unknown action: ${action}`);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (!authorized(req, url)) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/worlds') {
    json(res, 200, { worlds: loadWorlds() });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/runs') {
    json(res, 200, { runs: listRuns() });
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/runs/') && url.pathname.endsWith('/log')) {
    const id = url.pathname.slice('/api/runs/'.length, -'/log'.length);
    const run = runs.get(id);
    if (!run) {
      json(res, 404, { error: 'not found' });
      return;
    }
    const offset = Number(url.searchParams.get('offset') || 0);
    let text = '';
    try {
      const buf = fs.readFileSync(run.logPath);
      text = buf.slice(offset).toString('utf8');
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Log-Length': String(buf.length),
        'X-Run-Status': run.status,
      });
      res.end(text);
    } catch (e) {
      json(res, 500, { error: String(e) });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/runs') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let payload;
    try {
      payload = JSON.parse(body || '{}');
    } catch {
      json(res, 400, { error: 'invalid json' });
      return;
    }
    const worlds = loadWorlds();
    const world = worlds.find((w) => w.id === payload.worldId);
    if (!world && payload.action !== 'conformance') {
      json(res, 400, { error: 'unknown world' });
      return;
    }
    try {
      const cmd = buildCmd(payload.action, world || { id: 'repo' });
      const run = startRun(payload.action, payload.worldId || 'repo', cmd);
      json(res, 201, { run: { ...run, child: undefined } });
    } catch (e) {
      json(res, 400, { error: String(e?.message || e) });
    }
    return;
  }

  // static
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) {
    json(res, 403, { error: 'forbidden' });
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    json(res, 404, { error: 'not found' });
    return;
  }
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Fausth Lab listening on http://0.0.0.0:${PORT} (root=${ROOT})`);
});
