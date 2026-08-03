/**
 * What the app knows about you: a token and a list of repos. Nothing else.
 *
 * This is the only file in the app that touches browser storage, which keeps
 * "where does the credential live" a question with exactly one answer. The
 * storage object is passed in rather than reached for, so a test never needs a
 * browser — and the default is `sessionStorage`, never `localStorage`, because
 * closing the tab must remove a write-capable credential from the machine
 * (decision 3).
 */

/** One repo to watch, split because the GraphQL query needs the halves separately. */
export interface RepoRef {
  owner: string
  name: string
}

/** The whole of the user's configuration. Deliberately no third field. */
export interface Config {
  token: string
  repos: RepoRef[]
}

const KEY = 'overviewer-config'

/**
 * `owner/name` and full GitHub URLs both parse, because people paste URLs.
 * One segment for the owner, one for the name; anything deeper (issue links,
 * tree paths) still resolves to its repo.
 */
const SHAPE = /^(?:https?:\/\/(?:www\.)?github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/

/**
 * Whatever the user typed, as a repo reference — or `null` if it was not one.
 * Returning `null` rather than throwing means a typo is a red border, not a
 * broken app.
 */
export function parseRepo(input: string): RepoRef | null {
  const m = SHAPE.exec(input.trim())
  return m ? { owner: m[1] as string, name: m[2] as string } : null
}

/**
 * `"owner/name"` — the one place the two halves are joined back up. It is the
 * key the ETag table is indexed by and must match the `nameWithOwner` GitHub
 * returns, so it is written once here and reused, never re-derived.
 */
export function repoKey(r: RepoRef): string {
  return `${r.owner}/${r.name}`
}

/** True only for a value that actually has the `Config` shape. Stored JSON is untrusted. */
const isConfig = (v: unknown): v is Config => {
  if (v == null || typeof v !== 'object') return false
  const c = v as { token?: unknown; repos?: unknown }
  return (
    typeof c.token === 'string' &&
    c.token.length > 0 &&
    Array.isArray(c.repos) &&
    c.repos.length > 0 &&
    c.repos.every(
      (r: unknown) =>
        r != null &&
        typeof (r as RepoRef).owner === 'string' &&
        typeof (r as RepoRef).name === 'string',
    )
  )
}

/**
 * The saved configuration, or `null` when there is none or it is unreadable.
 * This is what decides whether the app boots live or on the recorded fixture.
 * Corrupt stored JSON returns `null` rather than throwing: a bad config should
 * send you to the paste screen, not a blank page.
 */
export function loadConfig(store: Storage = sessionStorage): Config | null {
  try {
    const raw = store.getItem(KEY)
    if (raw == null) return null
    const parsed: unknown = JSON.parse(raw)
    return isConfig(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function saveConfig(cfg: Config, store: Storage = sessionStorage): void {
  store.setItem(KEY, JSON.stringify(cfg))
}

/**
 * Sign-out — and also what a 401 triggers automatically, because a token GitHub
 * has stopped accepting is worse than no token: the app would keep retrying
 * with it.
 */
export function clearConfig(store: Storage = sessionStorage): void {
  store.removeItem(KEY)
}
