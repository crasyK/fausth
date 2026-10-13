/**
 * POSIX shell quoting for command strings handed to `bash -lc` (tmux launchers).
 * Every value becomes one literal word: single-quoted, with embedded single
 * quotes closed, escaped and reopened.
 * @param {unknown} value
 */
export function shellQuote(value) {
  const s = String(value);
  if (s === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Bash prelude for detached tmux sessions: enter the repo (fatal on failure),
 * best-effort nvm / .venv activation, load .env. Statements are `;`-separated so
 * an optional step cannot mask a failed `cd` (and vice versa).
 * @param {string} root repository root
 * @param {{ mkdirs?: string[] }} [opts] repo-relative dirs to create
 */
export function repoActivation(root, opts = {}) {
  return [
    `cd ${shellQuote(root)} || exit 97`,
    'export NVM_DIR="$HOME/.nvm"',
    'if [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh"; nvm use >/dev/null 2>&1 || true; fi',
    "if [ -f .venv/bin/activate ]; then . .venv/bin/activate; fi",
    "set -a; if [ -f .env ]; then . ./.env; fi; set +a",
    ...(opts.mkdirs ?? []).map((d) => `mkdir -p ${shellQuote(d)}`),
  ].join("; ");
}
