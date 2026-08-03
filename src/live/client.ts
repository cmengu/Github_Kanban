/**
 * Talks to GitHub — the only file in the app allowed to call `fetch`.
 *
 * Two-stage on purpose (decision 1): GitHub's GraphQL endpoint supports no
 * conditional requests at all, so every GraphQL poll costs points whether or
 * not anything changed — while a REST 304 costs nothing. So the cheap
 * conditional probe runs every cycle, and the expensive batched query runs only
 * for the repos the probe saw move.
 *
 * It holds no state between calls: the ETag table goes in as an argument and
 * comes back as a result, which is what lets a test replay any sequence of
 * polls with plain objects.
 */

import type { Config, RepoRef } from './config'
import type { Snapshot } from '../ingest/payloads'
import { repoKey } from './config'
import { batchQuery, readBatch } from './query'

/** Last version stamp seen per repo — `"owner/name"` → ETag. */
export type Etags = Record<string, string>

/**
 * What one poll actually spent. Not decoration — this is how you find out the
 * cheap path stopped working before the rate limit tells you.
 */
export interface PollCost {
  /** Conditional probe requests sent. */
  restCalls: number
  /** GraphQL rate-limit points burned, as reported by GitHub itself. */
  points: number
  /** Repos the probe let us skip — the 304s. */
  skipped: number
}

/** One cycle's result. `null` snapshot is the common case and the cheap one. */
export interface Poll {
  /** `null` means nothing changed — do not redraw. */
  snapshot: Snapshot | null
  /** Carried into the next poll; the app holds it, not this module. */
  etags: Etags
  /** Same honesty contract as `ingestProblems`. */
  problems: string[]
  cost: PollCost
  /** True when GitHub refused the token — the caller signs out (decision 3). */
  authFailed?: boolean
  /** Set when GitHub rate-limited us: what `backoffFor` needs to pick a wait. */
  limited?: { status: number; headers: Headers }
}

export interface PollOpts {
  /** Skip the probe and fetch everything — decision 2's backstop. */
  fullSweep?: boolean
  /** Injectable for tests. No test in this repo may touch the network. */
  fetchFn?: typeof fetch
}

const API = 'https://api.github.com'

/**
 * The single place the credential is attached — one place to audit, and one
 * place to guarantee the token never lands anywhere it could be logged: no
 * query strings, no error messages.
 */
export function authHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  }
}

const rateLimited = (status: number, headers: Headers): boolean =>
  status === 429 || (status === 403 && headers.get('x-ratelimit-remaining') === '0')

/**
 * The cheap half: one tiny conditional REST request per repo. A 304 answer
 * costs nothing at all against the rate limit (verified live). A repo with no
 * stored ETag counts as changed — the first poll after a reload must fetch
 * everything.
 */
export async function probeRepos(
  cfg: Config,
  etags: Etags,
  opts: PollOpts = {},
): Promise<{ changed: RepoRef[]; etags: Etags; problems: string[]; restCalls: number; authFailed: boolean; limited?: { status: number; headers: Headers } }> {
  const doFetch = opts.fetchFn ?? fetch
  const changed: RepoRef[] = []
  const next: Etags = { ...etags }
  const problems: string[] = []
  let restCalls = 0
  let authFailed = false
  let limited: { status: number; headers: Headers } | undefined

  for (const repo of cfg.repos) {
    const key = repoKey(repo)
    const headers: Record<string, string> = authHeaders(cfg.token)
    const stamp = etags[key]
    if (stamp != null) headers['if-none-match'] = stamp

    try {
      restCalls++
      const res = await doFetch(
        `${API}/repos/${repo.owner}/${repo.name}/issues?state=all&sort=updated&direction=desc&per_page=1`,
        { headers },
      )
      if (res.status === 304) continue
      if (res.status === 401) {
        authFailed = true
        problems.push(`${key}: GitHub refused the token (401) — signed out`)
        continue
      }
      if (rateLimited(res.status, res.headers)) {
        limited = { status: res.status, headers: res.headers }
        problems.push(`${key}: rate limited (${res.status}) — backing off`)
        continue
      }
      if (!res.ok) {
        problems.push(`${key}: probe answered ${res.status} — fetching anyway to stay honest`)
        changed.push(repo)
        continue
      }
      const etag = res.headers.get('etag')
      if (etag != null) next[key] = etag
      changed.push(repo)
    } catch (e) {
      problems.push(`${key}: probe failed — ${e instanceof Error ? e.message : 'network error'}`)
    }
  }

  return { changed, etags: next, problems, restCalls, authFailed, ...(limited ? { limited } : {}) }
}

/**
 * The expensive half: one batched GraphQL request for the repos worth asking
 * about. It stops at `Snapshot` — GitHub's own vocabulary, the exact shape
 * step 2 already eats — and does not go on to build a `DomainGraph`, which is
 * what keeps GitHub's words from leaking past `ingest.ts`.
 */
export async function fetchRepos(
  cfg: Config,
  repos: RepoRef[],
  opts: PollOpts = {},
): Promise<{ snapshot: Snapshot; problems: string[]; points: number; authFailed: boolean; limited?: { status: number; headers: Headers } }> {
  const doFetch = opts.fetchFn ?? fetch
  const { query, variables } = batchQuery(repos)

  try {
    const res = await doFetch(`${API}/graphql`, {
      method: 'POST',
      headers: { ...authHeaders(cfg.token), 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    })

    if (res.status === 401) {
      return {
        snapshot: { repos: [] },
        problems: ['GitHub refused the token (401) — signed out'],
        points: 0,
        authFailed: true,
      }
    }
    if (rateLimited(res.status, res.headers)) {
      return {
        snapshot: { repos: [] },
        problems: [`rate limited (${res.status}) — backing off`],
        points: 0,
        authFailed: false,
        limited: { status: res.status, headers: res.headers },
      }
    }
    if (!res.ok) {
      return {
        snapshot: { repos: [] },
        problems: [`GitHub answered ${res.status} to the batched query`],
        points: 0,
        authFailed: false,
      }
    }

    const body: unknown = await res.json()
    const read = readBatch(body, repos)
    const cost = (body as { data?: { rateLimit?: { cost?: unknown } } } | null)?.data?.rateLimit?.cost
    return {
      snapshot: { repos: read.repos },
      problems: read.problems,
      points: typeof cost === 'number' ? cost : 1,
      authFailed: false,
    }
  } catch (e) {
    return {
      snapshot: { repos: [] },
      problems: [`fetch failed — ${e instanceof Error ? e.message : 'network error'}`],
      points: 0,
      authFailed: false,
    }
  }
}

/**
 * Probe, then fetch what moved — the whole read path in one call.
 *
 * With `opts.fullSweep` the probe is skipped and everything is fetched
 * regardless: decision 2's backstop against a change detector we have not been
 * able to verify. Returns `snapshot: null` when nothing moved, so the caller
 * knows not to redraw.
 */
export async function pollOnce(cfg: Config, etags: Etags, opts: PollOpts = {}): Promise<Poll> {
  if (opts.fullSweep) {
    const full = await fetchRepos(cfg, cfg.repos, opts)
    return {
      snapshot: full.authFailed || full.limited ? null : full.snapshot,
      etags,
      problems: full.problems,
      cost: { restCalls: 0, points: full.points, skipped: 0 },
      ...(full.authFailed ? { authFailed: true } : {}),
      ...(full.limited ? { limited: full.limited } : {}),
    }
  }

  const probe = await probeRepos(cfg, etags, opts)
  const base: Poll = {
    snapshot: null,
    etags: probe.etags,
    problems: probe.problems,
    cost: { restCalls: probe.restCalls, points: 0, skipped: cfg.repos.length - probe.changed.length },
    ...(probe.authFailed ? { authFailed: true } : {}),
    ...(probe.limited ? { limited: probe.limited } : {}),
  }
  if (probe.authFailed || probe.changed.length === 0) return base

  const fetched = await fetchRepos(cfg, probe.changed, opts)
  return {
    ...base,
    snapshot: fetched.authFailed || fetched.limited ? null : fetched.snapshot,
    problems: [...probe.problems, ...fetched.problems],
    cost: { ...base.cost, points: fetched.points },
    ...(fetched.authFailed ? { authFailed: true } : {}),
    ...(fetched.limited ? { limited: fetched.limited } : {}),
  }
}
