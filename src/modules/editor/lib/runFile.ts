/** A deliberately small, predictable set of direct file runners. Commands
 * execute in a fresh terminal tab; unsupported file types show no Run button. */
function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function runCommandForPath(path: string): string | null {
  const file = path.split(/[\\/]/).pop() ?? path;
  const q = quotePosix(file);
  const lower = file.toLowerCase();
  if (/\.(py|pyw)$/.test(lower)) return `python3 ${q}`;
  if (/\.(js|mjs|cjs)$/.test(lower)) return `node ${q}`;
  if (/\.(sh|bash|zsh)$/.test(lower)) return `bash ${q}`;
  if (/\.go$/.test(lower)) return `go run ${q}`;
  if (/\.rb$/.test(lower)) return `ruby ${q}`;
  return null;
}

export function dirnameForPath(path: string): string | undefined {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : undefined;
}
