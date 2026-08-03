/**
 * GitHub's words in, ours out.
 *
 * This is the only file in the app that imports both vocabularies, and that is
 * deliberate — every other module gets to pretend the GitHub API does not
 * exist. It is pure, so the whole file is tested by reading a saved file and
 * comparing objects.
 *
 * Nothing here throws. This runs on a timer, so one strange issue must never
 * blank the whole screen; entries that cannot be read are skipped instead, and
 * `ingestProblems` reports every skip so the loss is never silent.
 *
 * The graph and the problem list come out of **one traversal** (`ingestAll`).
 * They were two separate walks once, and the two disagreed: three kinds of skip
 * happened silently because only one of the walks knew about them. Skip rules
 * written twice can only agree by hand.
 */

import type { DomainGraph, Edge, PullNode, PullRef, Ticket, TicketKey } from '../domain/types'
import type { IssuePayload, PullPayload, RepoPayload, Snapshot } from './payloads'

/** A ticket's identity: `"owner/repo#16"`. The one place a ticket key is minted. */
export function keyOf(repo: string, number: number): TicketKey {
  return `${repo}#${number}`
}

/**
 * An orphan pull request's identity: `"owner/repo!42"`.
 * `!` where tickets use `#`, because issues and pull requests share one
 * numbering space on GitHub — so PR 16 and issue 16 both exist, and a shared
 * key format would silently merge them.
 */
export function pullKeyOf(repo: string, number: number): string {
  return `${repo}!${number}`
}

/** Reads a GraphQL connection defensively — the wrapper itself may be missing. */
const nodesOf = <T>(conn: { nodes?: T[] } | null | undefined): T[] =>
  Array.isArray(conn?.nodes) ? conn.nodes.filter((n): n is T => n != null) : []

/** True when the wrapper is present but unusable, as opposed to simply absent. */
const brokenConnection = (conn: unknown): boolean =>
  conn != null && (typeof conn !== 'object' || !Array.isArray((conn as { nodes?: unknown }).nodes))

const hasRepoKey = (r: RepoPayload | null | undefined): r is RepoPayload =>
  r != null && typeof r.nameWithOwner === 'string' && r.nameWithOwner.length > 0

const hasNumber = <T extends { number?: unknown }>(x: T | null | undefined): x is T & { number: number } =>
  x != null && typeof x.number === 'number' && Number.isFinite(x.number)

const PULL_STATES = ['open', 'merged', 'closed'] as const

/**
 * GitHub's pull-request state in our spelling, or `null` when it is not a state
 * we recognise. Shared by `toPullRef` and the traversal so the value used and
 * the value reported can never come from two different rules.
 */
const pullStateOf = (raw: unknown): PullRef['state'] | null => {
  const s = typeof raw === 'string' ? raw.toLowerCase() : ''
  return (PULL_STATES as readonly string[]).includes(s) ? (s as PullRef['state']) : null
}

/**
 * One pull request, in our vocabulary.
 *
 * `awaitingReview` is decided here and nowhere else: a draft is never waiting
 * on you, and neither is a pull request that is already merged or closed. An
 * unreadable state counts as closed, so a PR we cannot understand can never
 * claim a review that may not exist.
 */
export function toPullRef(p: PullPayload): PullRef {
  const state = pullStateOf(p.state) ?? 'closed'
  return {
    number: p.number,
    state,
    awaitingReview: state === 'open' && !p.isDraft && p.reviewDecision === 'REVIEW_REQUIRED',
    url: typeof p.url === 'string' ? p.url : '',
  }
}

/**
 * One issue, in our vocabulary.
 *
 * Every small translation lives here: `'OPEN'` becomes `'open'`, a list of
 * assignees becomes one name or `null`, labels become plain strings. Each of
 * those is a decision about what we mean, made once, in one place.
 */
export function toTicket(repo: string, issue: IssuePayload, prs: PullRef[]): Ticket {
  return {
    key: keyOf(repo, issue.number),
    title: typeof issue.title === 'string' ? issue.title : '',
    state: issue.state === 'CLOSED' ? 'closed' : 'open',
    assignee: nodesOf(issue.assignees).map((a) => a?.login).find((l) => typeof l === 'string') ?? null,
    labels: nodesOf(issue.labels)
      .map((l) => l?.name)
      .filter((n): n is string => typeof n === 'string'),
    prs,
    url: typeof issue.url === 'string' ? issue.url : '',
  }
}

/**
 * Every native blocked-by relation, as an `Edge` — copied out **verbatim**,
 * including ones pointing at repos that were never loaded.
 *
 * Ingest sees one repo at a time, so it genuinely cannot tell a missing blocker
 * from an unprocessed one. `indexOf` already drops the danglers once it can see
 * the whole graph. Filter where you can see everything, not where you arrive
 * first.
 */
export function edgesOf(repo: RepoPayload): Edge[] {
  const out: Edge[] = []

  for (const issue of nodesOf(repo.issues)) {
    if (!hasNumber(issue)) continue
    for (const ref of nodesOf(issue.blockedBy)) {
      if (!hasNumber(ref)) continue
      out.push({
        blocked: keyOf(repo.nameWithOwner, issue.number),
        by: keyOf(ref.repository?.nameWithOwner ?? repo.nameWithOwner, ref.number),
      })
    }
  }

  return out
}

/** Everything one traversal produces. Kept private so callers see two clean functions. */
interface Ingested {
  graph: DomainGraph
  problems: string[]
}

/**
 * The single walk. Folding runs across the **whole snapshot** before any ticket
 * is built, because a pull request may close an issue in another repo — and a
 * per-repo fold quietly dropped those, which is precisely the loss `PullNode`
 * was added to prevent.
 */
function ingestAll(snap: Snapshot): Ingested {
  const problems: string[] = []
  const repos = Array.isArray(snap?.repos) ? snap.repos : []
  if (snap?.repos != null && !Array.isArray(snap.repos)) {
    problems.push('snapshot: skipped everything — `repos` is not a list')
  }

  // ---- pass 1: which repos and issues can be read at all ----
  const good: RepoPayload[] = []
  const ticketKeys = new Set<TicketKey>()

  repos.forEach((repo, i) => {
    if (!hasRepoKey(repo)) {
      problems.push(`repo at position ${i}: skipped — no nameWithOwner, so its tickets could not be keyed`)
      return
    }
    if (brokenConnection(repo.issues)) problems.push(`${repo.nameWithOwner}: issues list could not be read`)
    if (brokenConnection(repo.pullRequests)) problems.push(`${repo.nameWithOwner}: pull request list could not be read`)

    good.push(repo)
    for (const issue of nodesOf(repo.issues)) {
      if (!hasNumber(issue)) {
        problems.push(`${repo.nameWithOwner}: skipped an issue with no number — nothing to key it by`)
        continue
      }
      ticketKeys.add(keyOf(repo.nameWithOwner, issue.number))
    }
  })

  // ---- pass 2: fold pull requests onto tickets, across every repo ----
  const folded = new Map<TicketKey, PullRef[]>()
  const pulls: PullNode[] = []

  for (const repo of good) {
    const seen = new Set<number>()

    for (const p of nodesOf(repo.pullRequests)) {
      if (!hasNumber(p)) {
        problems.push(`${repo.nameWithOwner}: skipped a pull request with no number`)
        continue
      }
      if (seen.has(p.number)) continue // the same PR twice, from overlapping pages
      seen.add(p.number)

      if (pullStateOf(p.state) === null) {
        problems.push(`${repo.nameWithOwner}!${p.number}: unrecognised state ${JSON.stringify(p.state)} — treated as closed`)
      }

      const ref = toPullRef(p)
      const refs = nodesOf(p.closingIssuesReferences)
      let landed = false

      for (const target of refs) {
        if (!hasNumber(target)) {
          problems.push(`${repo.nameWithOwner}!${p.number}: a closing reference had no issue number`)
          continue
        }
        const key = keyOf(target.repository?.nameWithOwner ?? repo.nameWithOwner, target.number)
        if (!ticketKeys.has(key)) {
          problems.push(`${repo.nameWithOwner}!${p.number}: closes ${key}, which was not loaded — kept as its own node`)
          continue
        }
        const list = folded.get(key)
        if (list) list.push(ref)
        else folded.set(key, [ref])
        landed = true
      }

      // No reference at all, or none that reached a loaded ticket. Either way it
      // becomes its own node rather than disappearing (story 15).
      if (!landed) {
        pulls.push({
          key: pullKeyOf(repo.nameWithOwner, p.number),
          repo: repo.nameWithOwner,
          title: typeof p.title === 'string' ? p.title : '',
          state: ref.state,
          awaitingReview: ref.awaitingReview,
          url: ref.url,
        })
      }
    }
  }

  // ---- pass 3: build the graph ----
  const tickets: Ticket[] = []
  const edges: Edge[] = []

  for (const repo of good) {
    for (const issue of nodesOf(repo.issues)) {
      if (!hasNumber(issue)) continue
      const key = keyOf(repo.nameWithOwner, issue.number)
      tickets.push(toTicket(repo.nameWithOwner, issue, folded.get(key) ?? []))
    }
    edges.push(...edgesOf(repo))
  }

  return { graph: { tickets, edges, pulls }, problems }
}

/**
 * For each ticket, the pull requests that close it — decision #6's folding.
 * A PR becomes a ring on its issue's orb rather than a node of its own, which
 * keeps the picture a ticket graph instead of doubling its size.
 *
 * Takes the whole snapshot, not one repo: a pull request may close an issue in
 * a different repo, and only the full picture can resolve that.
 */
export function foldPulls(snap: Snapshot): Map<TicketKey, PullRef[]> {
  const byKey = new Map<TicketKey, PullRef[]>()
  for (const t of ingestAll(snap).graph.tickets) {
    if (t.prs.length > 0) byKey.set(t.key, t.prs)
  }
  return byKey
}

/**
 * The pull requests that end up as their own node — those closing no issue, and
 * those whose issue was never loaded. In-flight work that would otherwise
 * vanish (story 15).
 */
export function orphanPulls(snap: Snapshot): PullNode[] {
  return ingestAll(snap).graph.pulls
}

/**
 * One poll's worth of GitHub data, as the graph the rest of the app already
 * knows how to draw. **The entire seam** — everything else in this file exists
 * to build it. Step 3 hands it live data instead of saved data, and this
 * signature does not change.
 */
export function toDomainGraph(snap: Snapshot): DomainGraph {
  return ingestAll(snap).graph
}

/**
 * Every entry `toDomainGraph` had to skip, and why.
 *
 * `toDomainGraph` never throws, so without this the drops would be silent —
 * and a silently missing ticket is indistinguishable from a bug. Both come from
 * the same traversal, so this list cannot fall out of step with the graph.
 */
export function ingestProblems(snap: Snapshot): string[] {
  return ingestAll(snap).problems
}

/**
 * Reads a saved or fetched payload as a `Snapshot`.
 *
 * It exists so that nothing outside this file has to name GitHub's vocabulary:
 * `demo.ts` imported the `Snapshot` type only to write the cast, which quietly
 * broke the rule that one file knows both languages.
 */
export function readSnapshot(raw: unknown): Snapshot {
  return (raw ?? { repos: [] }) as Snapshot
}
