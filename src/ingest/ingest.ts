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

const usable = (repo: RepoPayload | null | undefined): repo is RepoPayload =>
  repo != null && typeof repo.nameWithOwner === 'string' && repo.nameWithOwner.length > 0

const readable = (issue: IssuePayload | null | undefined): issue is IssuePayload =>
  issue != null && typeof issue.number === 'number'

const readablePull = (p: PullPayload | null | undefined): p is PullPayload =>
  p != null && typeof p.number === 'number'

/**
 * One pull request, in our vocabulary.
 *
 * `awaitingReview` is decided here and nowhere else: a draft is never waiting
 * on you, and neither is a pull request that is already merged or closed.
 */
export function toPullRef(p: PullPayload): PullRef {
  const state = (p.state ?? 'OPEN').toLowerCase() as PullRef['state']
  return {
    number: p.number,
    state,
    awaitingReview: state === 'open' && !p.isDraft && p.reviewDecision === 'REVIEW_REQUIRED',
    url: p.url ?? '',
  }
}

/**
 * For each ticket, the pull requests that close it — decision #6's folding.
 * A PR becomes a ring on its issue's orb rather than a node of its own, which
 * keeps the picture a ticket graph instead of doubling its size.
 */
export function foldPulls(repo: RepoPayload): Map<TicketKey, PullRef[]> {
  const out = new Map<TicketKey, PullRef[]>()

  for (const p of nodesOf(repo.pullRequests)) {
    if (!readablePull(p)) continue
    for (const ref of nodesOf(p.closingIssuesReferences)) {
      const owner = ref.repository?.nameWithOwner ?? repo.nameWithOwner
      const key = keyOf(owner, ref.number)
      const list = out.get(key)
      if (list) list.push(toPullRef(p))
      else out.set(key, [toPullRef(p)])
    }
  }

  return out
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
    if (!readable(issue)) continue
    for (const ref of nodesOf(issue.blockedBy)) {
      if (typeof ref?.number !== 'number') continue
      out.push({
        blocked: keyOf(repo.nameWithOwner, issue.number),
        by: keyOf(ref.repository?.nameWithOwner ?? repo.nameWithOwner, ref.number),
      })
    }
  }

  return out
}

/**
 * The pull requests that close no issue — in-flight work that would otherwise
 * vanish (story 15). This is the only moment the raw PR list is in scope.
 */
export function orphanPulls(repo: RepoPayload): PullNode[] {
  return nodesOf(repo.pullRequests)
    .filter(readablePull)
    .filter((p) => nodesOf(p.closingIssuesReferences).length === 0)
    .map((p) => {
      const ref = toPullRef(p)
      return {
        key: pullKeyOf(repo.nameWithOwner, p.number),
        repo: repo.nameWithOwner,
        title: p.title ?? '',
        state: ref.state,
        awaitingReview: ref.awaitingReview,
        url: ref.url,
      }
    })
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
    title: issue.title ?? '',
    state: issue.state === 'CLOSED' ? 'closed' : 'open',
    assignee: nodesOf(issue.assignees)[0]?.login ?? null,
    labels: nodesOf(issue.labels).map((l) => l.name),
    prs,
    url: issue.url ?? '',
  }
}

/**
 * One poll's worth of GitHub data, as the graph the rest of the app already
 * knows how to draw. **The entire seam** — everything else in this file exists
 * to build it. Step 3 hands it live data instead of saved data, and this
 * signature does not change.
 */
export function toDomainGraph(snap: Snapshot): DomainGraph {
  const tickets: Ticket[] = []
  const edges: Edge[] = []
  const pulls: PullNode[] = []

  for (const repo of snap?.repos ?? []) {
    if (!usable(repo)) continue

    const folded = foldPulls(repo)
    for (const issue of nodesOf(repo.issues)) {
      if (!readable(issue)) continue
      const key = keyOf(repo.nameWithOwner, issue.number)
      tickets.push(toTicket(repo.nameWithOwner, issue, folded.get(key) ?? []))
    }

    edges.push(...edgesOf(repo))
    pulls.push(...orphanPulls(repo))
  }

  return { tickets, edges, pulls }
}

/**
 * Every entry `toDomainGraph` had to skip, and why.
 *
 * `toDomainGraph` never throws, so without this the drops would be silent —
 * and a silently missing ticket is indistinguishable from a bug.
 */
export function ingestProblems(snap: Snapshot): string[] {
  const out: string[] = []

  const repos = snap?.repos ?? []
  repos.forEach((repo, i) => {
    if (!usable(repo)) {
      out.push(`repo at position ${i}: skipped — no nameWithOwner, so its tickets could not be keyed`)
      return
    }
    for (const issue of nodesOf(repo.issues)) {
      if (!readable(issue)) {
        out.push(`${repo.nameWithOwner}: skipped an issue with no number — nothing to key it by`)
      }
    }
    for (const p of nodesOf(repo.pullRequests)) {
      if (!readablePull(p)) {
        out.push(`${repo.nameWithOwner}: skipped a pull request with no number`)
      }
    }
  })

  return out
}
