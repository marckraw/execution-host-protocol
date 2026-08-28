/**
 * One truth for "are these two remotes the same repository?".
 *
 * A checkout's origin is written a dozen ways — `git@host:owner/repo.git`,
 * `https://host/owner/repo`, the same with a token in front of the host, with
 * a port, with a trailing slash, in somebody's preferred capitalisation. A
 * client matching its local checkout against a host's advertised Projects
 * would otherwise have to reinvent this comparison, and every reinvention
 * disagrees at a different edge. So the normalizer lives here, in the contract
 * both sides already share (ADR-0011 §4), and the comparison becomes equality.
 */

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
/** `[user@]host:path` — git's scp-like form, which is not a URL. */
const SCP_LIKE = /^(?:[^@/]+@)?([^@/:]+):(.+)$/;

/**
 * Collapses any spelling of a git remote to `host/owner/repo`, lowercased and
 * without the `.git` suffix. Returns null for anything that names no host and
 * path — a local path, a bare directory, an empty string — because those have
 * no identity to join on.
 *
 * Credentials embedded in the URL are dropped rather than normalized: the key
 * is a join key, and a key nobody can print by accident is the safer one.
 */
export function normalizeOriginKey(
  url: string | null | undefined,
): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;

  const parts = SCHEME.test(trimmed)
    ? splitUrlForm(trimmed)
    : (splitScpForm(trimmed) ?? splitBareKeyForm(trimmed));
  if (!parts) return null;

  const host = parts.host.toLowerCase();
  const path = normalizePath(parts.path);
  if (host.length === 0 || path.length === 0) return null;

  return `${host}/${path}`.toLowerCase();
}

function splitUrlForm(url: string): { host: string; path: string } | null {
  const rest = url.slice(url.indexOf("://") + 3);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  return {
    host: stripPort(stripUserInfo(rest.slice(0, slash))),
    path: rest.slice(slash + 1),
  };
}

function splitScpForm(url: string): { host: string; path: string } | null {
  const match = SCP_LIKE.exec(url);
  // No port stripping here on purpose: in scp-like syntax everything after the
  // colon is a path, so `host:22/owner/repo` names a directory called 22, and
  // git reads it that way too.
  return match ? { host: match[1] as string, path: match[2] as string } : null;
}

/**
 * `host/owner/repo` — the shape this function itself returns. Accepting it
 * back makes the normalizer total over its own output, so a caller that
 * normalizes an already-normalized key gets the key rather than null. The
 * guards keep it from swallowing things that only look like one: a bare
 * `owner/repo` names no host, and a leading slash means a local path.
 */
function splitBareKeyForm(url: string): { host: string; path: string } | null {
  if (url.startsWith("/") || /[\s:]/.test(url)) return null;

  const segments = url.split("/").filter((segment) => segment.length > 0);
  const host = segments[0];
  if (segments.length < 3 || host === undefined) return null;
  if (!host.includes(".") && host !== "localhost") return null;

  return { host, path: segments.slice(1).join("/") };
}

function stripUserInfo(authority: string): string {
  const at = authority.lastIndexOf("@");
  return at < 0 ? authority : authority.slice(at + 1);
}

function stripPort(host: string): string {
  const colon = host.lastIndexOf(":");
  return colon > 0 && /^\d+$/.test(host.slice(colon + 1))
    ? host.slice(0, colon)
    : host;
}

function normalizePath(rawPath: string): string {
  const withoutQuery = rawPath.split("?")[0]?.split("#")[0] ?? "";
  const segments = withoutQuery
    .split("/")
    .filter((segment) => segment.length > 0);
  const last = segments.pop();
  if (last === undefined) return "";

  const repo = last.replace(/\.git$/i, "");
  return repo.length === 0 ? "" : [...segments, repo].join("/");
}
