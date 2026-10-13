/**
 * Minimal `.env` loader shared by host scripts (no dependency, no logging of values).
 *
 * Existing environment variables always win: the file only fills keys that are unset.
 */
import { existsSync, readFileSync } from "node:fs";

/**
 * Parse dotenv text into key/value pairs. Supports `KEY=value`, optional
 * `export ` prefix, `#` comment lines and single/double-quoted values.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseDotEnv(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    let t = line.trim();
    if (!t || t.startsWith("#")) continue;
    if (t.startsWith("export ")) t = t.slice("export ".length).trim();
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = t.slice(eq + 1).trim();
    if (
      val.length >= 2 &&
      ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/**
 * Load `path` into `env` without overriding keys that are already set.
 * @param {string} path
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]} keys that were filled from the file (never values)
 */
export function loadDotEnv(path, env = process.env) {
  if (!path || !existsSync(path)) return [];
  const parsed = parseDotEnv(readFileSync(path, "utf8"));
  /** @type {string[]} */
  const loaded = [];
  for (const [key, val] of Object.entries(parsed)) {
    if (env[key] === undefined) {
      env[key] = val;
      loaded.push(key);
    }
  }
  return loaded;
}
