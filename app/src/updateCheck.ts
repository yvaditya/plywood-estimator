/**
 * "There's a newer build" check.
 *
 * Asks GitHub how the running build's commit relates to the repo's branch head
 * and, when it is genuinely behind, offers a download link. Everything here is
 * best-effort: the app must start and work identically with no network, a
 * rate-limited API, or a commit GitHub has never seen.
 *
 * Uses the COMPARE endpoint rather than comparing sha strings. The person
 * running this is usually the person committing to it, so a bare sha mismatch
 * is just as likely to mean "you have unpushed work" as "you are out of date" —
 * and nagging someone to download a build older than the one they are running
 * is worse than saying nothing. `compare` distinguishes behind / ahead /
 * diverged / identical, and only `behind` is worth a prompt.
 */

const REPO = 'yvaditya/plywood-estimator';
const BRANCH = 'master';
/** Bumped if the cached shape changes. */
const CACHE_KEY = 'wc.updateCheck.v1';
const DISMISS_KEY = 'wc.updateDismiss.v1';
/** Unauthenticated GitHub allows 60 requests/hour per IP, and a dev session
 *  reloads constantly — one check per six hours is plenty for a desktop app. */
const CACHE_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;

export interface UpdateInfo {
  /** Commits the running build is behind the branch head. */
  behindBy: number;
  /** Branch head sha — also the dismissal key, so dismissing one update
   *  doesn't suppress the next. */
  headSha: string;
  downloadUrl: string;
  compareUrl: string;
}

interface Cached {
  at: number;
  /** Local sha the cached answer was computed FOR — a rebuild at a new commit
   *  must not read a stale verdict about the old one. */
  local: string;
  info: UpdateInfo | null;
}

function readCache(localSha: string): Cached | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Cached;
    if (c.local !== localSha) return null;
    if (Date.now() - c.at > CACHE_MS) return null;
    return c;
  } catch {
    return null;
  }
}

/** Remember the head sha the user dismissed, not a boolean — the next release
 *  should still be able to speak up. */
export function dismissUpdate(headSha: string) {
  try { localStorage.setItem(DISMISS_KEY, headSha); } catch { /* quota */ }
}

function isDismissed(headSha: string): boolean {
  try { return localStorage.getItem(DISMISS_KEY) === headSha; } catch { return false; }
}

async function fetchCompare(localSha: string): Promise<UpdateInfo | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/compare/${localSha}...${BRANCH}`,
      { signal: ctrl.signal, headers: { Accept: 'application/vnd.github+json' } },
    );
    // 404 = GitHub has never seen this commit (unpushed local work);
    // 403 = rate limited. Neither is an error worth showing anyone.
    if (!res.ok) return null;
    const data = await res.json() as {
      status?: string; behind_by?: number; html_url?: string;
      base_commit?: { sha?: string }; commits?: { sha?: string }[];
    };
    if (data.status !== 'behind') return null;
    const behindBy = data.behind_by ?? 0;
    if (behindBy <= 0) return null;
    // The branch head is the LAST commit in the compare range.
    const headSha = data.commits?.[data.commits.length - 1]?.sha ?? '';
    return {
      behindBy,
      headSha,
      downloadUrl: `https://github.com/${REPO}/archive/refs/heads/${BRANCH}.zip`,
      compareUrl: data.html_url ?? `https://github.com/${REPO}/commits/${BRANCH}`,
    };
  } catch {
    return null;                    // offline, DNS, abort — all silent
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve to the pending update, or null when there is nothing to say.
 * Never throws and never blocks startup — call it and ignore the promise if
 * you like.
 */
export async function checkForUpdate(localSha: string): Promise<UpdateInfo | null> {
  if (!localSha || !/^[0-9a-f]{7,40}$/i.test(localSha)) return null;
  const cached = readCache(localSha);
  const info = cached ? cached.info : await fetchCompare(localSha);
  if (!cached) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), local: localSha, info }));
    } catch { /* quota */ }
  }
  if (!info) return null;
  return isDismissed(info.headSha) ? null : info;
}
