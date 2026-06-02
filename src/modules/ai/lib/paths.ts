/**
 * Resolve a possibly-relative path against the active terminal cwd.
 *
 * Absolute paths (POSIX `/...` or Windows `C:\...`) are returned as-is.
 * Relative paths require a cwd; without one we throw rather than guess.
 */
export function resolvePath(rawPath: string, cwd: string | null): string {
  if (rawPath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(rawPath))
    return rawPath;
  if (!cwd)
    throw new Error(
      `cannot resolve relative path "${rawPath}": no active terminal cwd. Pass an absolute path.`,
    );
  const sep = cwd.includes("\\") && !cwd.includes("/") ? "\\" : "/";
  return cwd.endsWith(sep) ? `${cwd}${rawPath}` : `${cwd}${sep}${rawPath}`;
}
