/**
 * The third pinned seam: recorded GitHub payloads in, DomainGraph out.
 *
 * Assertions are made against facts anyone can check on github.com rather than
 * against a checked-in expected graph. A snapshot of our own output would only
 * prove the code still does what it did, never that it does the right thing.
 */

import { describe, expect, it } from 'vitest'
import {
  edgesOf,
  foldPulls,
  ingestProblems,
  keyOf,
  orphanPulls,
  pullKeyOf,
  toDomainGraph,
  toPullRef,
} from '../src/ingest/ingest'
import type { PullPayload, RepoPayload, Snapshot } from '../src/ingest/payloads'
import { bucketOf } from '../src/domain/derive'
import recorded from '../src/fixtures/payloads/snapshot.json'

const snap = recorded as Snapshot
const REPO = 'cmengu/Github_Kanban'

/** A payload builder, for the cases the recording does not contain. */
const conn = <T>(nodes: T[]) => ({ nodes })
const issue = (number: number, over: Partial<Snapshot> & Record<string, unknown> = {}) => ({
  number,
  title: `issue ${number}`,
  state: 'OPEN' as const,
  url: `https://github.com/${REPO}/issues/${number}`,
  assignees: conn<{ login: string }>([]),
  labels: conn<{ name: string }>([]),
  blockedBy: conn<{ number: number; repository: { nameWithOwner: string } }>([]),
  ...over,
})
const pull = (number: number, over: Partial<PullPayload> = {}): PullPayload => ({
  number,
  title: `pr ${number}`,
  state: 'OPEN',
  url: `https://github.com/${REPO}/pull/${number}`,
  isDraft: false,
  reviewDecision: null,
  closingIssuesReferences: conn([]),
  ...over,
})
const repo = (issues: unknown[] = [], pulls: PullPayload[] = []): RepoPayload =>
  ({ nameWithOwner: REPO, issues: conn(issues), pullRequests: conn(pulls) }) as RepoPayload

describe('keys — minted in exactly one place', () => {
  it('builds a ticket key from a repo and a number', () => {
    expect(keyOf(REPO, 16)).toBe('cmengu/Github_Kanban#16')
  })

  it('gives orphan pull requests a key that can never collide with a ticket', () => {
    expect(pullKeyOf(REPO, 16)).toBe('cmengu/Github_Kanban!16')
    expect(pullKeyOf(REPO, 16)).not.toBe(keyOf(REPO, 16))
  })
})

describe('the recorded snapshot — facts you can check on GitHub', () => {
  const g = toDomainGraph(snap)

  it('produces one ticket per recorded issue', () => {
    expect(g.tickets).toHaveLength(16)
    expect(g.tickets.map((t) => t.key)).toContain('cmengu/Github_Kanban#16')
  })

  it('carries the real dependency edges, and only those', () => {
    expect(g.edges).toHaveLength(5)
    const of = (k: string) => g.edges.filter((e) => e.blocked === keyOf(REPO, Number(k))).map((e) => e.by)
    expect(of('4').sort()).toEqual([keyOf(REPO, 10), keyOf(REPO, 3)].sort())
    expect(of('11')).toEqual([keyOf(REPO, 4)])
    expect(of('12')).toEqual([keyOf(REPO, 10)])
    expect(of('13')).toEqual([keyOf(REPO, 2)])
  })

  it('translates GitHub\'s vocabulary into ours', () => {
    const t = g.tickets.find((x) => x.key === keyOf(REPO, 16))!
    expect(t.state).toBe('open')
    expect(t.labels).toEqual(['ready-for-agent'])
    expect(t.assignee).toBeNull()
    expect(t.title).toContain('Spec: Overviewer v2')
  })

  it('takes the first assignee, because a Ticket holds one', () => {
    const t = g.tickets.find((x) => x.key === keyOf(REPO, 2))!
    expect(t.assignee).toBe('cmengu')
  })

  it('keeps the merged step 1 pull request as an orphan node', () => {
    expect(g.pulls).toHaveLength(1)
    expect(g.pulls[0]).toMatchObject({
      key: 'cmengu/Github_Kanban!17',
      repo: REPO,
      state: 'merged',
      awaitingReview: false,
    })
  })

  it('leaves the #4 bucket table working on real data', () => {
    const bucket = (n: number) => bucketOf(g.tickets.find((t) => t.key === keyOf(REPO, n))!)
    expect(bucket(2)).toBe('done')      // closed, and assigned — closed wins
    expect(bucket(14)).toBe('tickets')  // open, unassigned, no PR
    expect(bucket(16)).toBe('tickets')
    expect(g.tickets.filter((t) => t.state === 'closed')).toHaveLength(14)
  })

  it('is deterministic, and does not care what order repos arrive in', () => {
    expect(toDomainGraph(snap)).toEqual(toDomainGraph(snap))
    const two: Snapshot = { repos: [...snap.repos, repo([issue(99)])] }
    const flipped: Snapshot = { repos: [...two.repos].reverse() }
    expect(toDomainGraph(flipped).tickets.map((t) => t.key).sort())
      .toEqual(toDomainGraph(two).tickets.map((t) => t.key).sort())
  })

  it('reports no problems for a clean recording', () => {
    expect(ingestProblems(snap)).toEqual([])
  })
})

describe('edgesOf — verbatim, no filtering', () => {
  it('emits an edge for every blocked-by relation', () => {
    const r = repo([issue(2, { blockedBy: conn([{ number: 1, repository: { nameWithOwner: REPO } }]) })])
    expect(edgesOf(r)).toEqual([{ blocked: keyOf(REPO, 2), by: keyOf(REPO, 1) }])
  })

  it('keeps a blocker in a repo that was never loaded, and lets indexOf drop it', () => {
    const r = repo([issue(2, { blockedBy: conn([{ number: 9, repository: { nameWithOwner: 'other/repo' } }]) })])
    expect(edgesOf(r)).toEqual([{ blocked: keyOf(REPO, 2), by: keyOf('other/repo', 9) }])
  })
})

describe('pull requests — folded or orphaned, never both, never dropped', () => {
  it('folds a PR onto the issue it closes', () => {
    const r = repo([issue(1)], [pull(5, { closingIssuesReferences: conn([{ number: 1, repository: { nameWithOwner: REPO } }]) })])
    expect(foldPulls({ repos: [r] }).get(keyOf(REPO, 1))).toHaveLength(1)
    expect(orphanPulls({ repos: [r] })).toEqual([])
  })

  it('keeps a PR that closes nothing as its own node', () => {
    const r = repo([issue(1)], [pull(5)])
    expect(foldPulls({ repos: [r] }).size).toBe(0)
    expect(orphanPulls({ repos: [r] }).map((p) => p.key)).toEqual([pullKeyOf(REPO, 5)])
  })

  it('stacks several PRs on one issue', () => {
    const closes = conn([{ number: 1, repository: { nameWithOwner: REPO } }])
    const r = repo([issue(1)], [pull(5, { closingIssuesReferences: closes }), pull(6, { closingIssuesReferences: closes })])
    expect(foldPulls({ repos: [r] }).get(keyOf(REPO, 1))).toHaveLength(2)
  })

  it('folds a PR onto an issue in a different repo', () => {
    const a = { nameWithOwner: 'o/a', issues: conn([]), pullRequests: conn([pull(7, { closingIssuesReferences: conn([{ number: 1, repository: { nameWithOwner: 'o/b' } }]) })]) } as RepoPayload
    const b = { nameWithOwner: 'o/b', issues: conn([issue(1)]), pullRequests: conn([]) } as RepoPayload
    const g = toDomainGraph({ repos: [a, b] })

    expect(g.tickets.find((t) => t.key === 'o/b#1')!.prs).toHaveLength(1)
    expect(g.pulls).toEqual([])
  })

  it('keeps a PR whose issue was never loaded, rather than losing it', () => {
    const r = repo([issue(1)], [pull(7, { closingIssuesReferences: conn([{ number: 99, repository: { nameWithOwner: REPO } }]) })])
    const g = toDomainGraph({ repos: [r] })

    expect(g.pulls.map((p) => p.key)).toEqual([pullKeyOf(REPO, 7)])
    expect(ingestProblems({ repos: [r] }).join(' ')).toMatch(/closes .*#99, which was not loaded/)
  })

  it('counts the same PR once when pages overlap', () => {
    const closes = conn([{ number: 1, repository: { nameWithOwner: REPO } }])
    const r = repo([issue(1)], [pull(5, { closingIssuesReferences: closes }), pull(5, { closingIssuesReferences: closes })])
    expect(toDomainGraph({ repos: [r] }).tickets[0]!.prs).toHaveLength(1)
  })

  it('puts an issue with an open PR in review, through the whole pipeline', () => {
    const r = repo([issue(1)], [pull(5, { closingIssuesReferences: conn([{ number: 1, repository: { nameWithOwner: REPO } }]) })])
    const g = toDomainGraph({ repos: [r] })
    expect(bucketOf(g.tickets[0]!)).toBe('in-review')
  })
})

describe('toPullRef — where draft and review-decision are interpreted', () => {
  it('marks a PR awaiting review when GitHub says a review is required', () => {
    expect(toPullRef(pull(1, { reviewDecision: 'REVIEW_REQUIRED' })).awaitingReview).toBe(true)
  })

  it('never marks a draft as awaiting review — nobody is waiting on you', () => {
    expect(toPullRef(pull(1, { isDraft: true, reviewDecision: 'REVIEW_REQUIRED' })).awaitingReview).toBe(false)
  })

  it('never marks a closed or merged PR as awaiting review', () => {
    expect(toPullRef(pull(1, { state: 'MERGED', reviewDecision: 'REVIEW_REQUIRED' })).awaitingReview).toBe(false)
  })

  it('lowercases the state', () => {
    expect(toPullRef(pull(1, { state: 'MERGED' })).state).toBe('merged')
  })

  it('treats an unreadable state as closed, so it can never claim a review', () => {
    const odd = toPullRef(pull(1, { state: 'WEIRD' as never, reviewDecision: 'REVIEW_REQUIRED' }))
    expect(odd.state).toBe('closed')
    expect(odd.awaitingReview).toBe(false)
  })

  it('reports an unreadable state rather than swallowing it', () => {
    const r = repo([], [pull(1, { state: 'WEIRD' as never })])
    expect(ingestProblems({ repos: [r] }).join(' ')).toMatch(/unrecognised state/)
  })
})

describe('a bad entry is skipped, not fatal', () => {
  const broken: Snapshot = {
    repos: [
      { nameWithOwner: REPO, issues: conn([issue(1), { number: null } as never]), pullRequests: conn([]) } as RepoPayload,
      { nameWithOwner: '', issues: conn([issue(2)]), pullRequests: conn([]) } as RepoPayload,
      null as never,
    ],
  }

  it('still returns a graph rather than throwing', () => {
    expect(() => toDomainGraph(broken)).not.toThrow()
    expect(toDomainGraph(broken).tickets.map((t) => t.key)).toEqual([keyOf(REPO, 1)])
  })

  it('survives missing connection wrappers entirely', () => {
    const bare = { repos: [{ nameWithOwner: REPO } as never] }
    expect(toDomainGraph(bare).tickets).toEqual([])
  })

  it('does not throw when repos is not a list at all', () => {
    const wrong = { repos: {} } as never
    expect(() => toDomainGraph(wrong)).not.toThrow()
    expect(() => ingestProblems(wrong)).not.toThrow()
    expect(ingestProblems(wrong).join(' ')).toMatch(/not a list/)
  })

  it('reports a connection wrapper that is present but unreadable', () => {
    const odd = { repos: [{ nameWithOwner: REPO, issues: 'nope', pullRequests: conn([]) } as never] }
    expect(toDomainGraph(odd).tickets).toEqual([])
    expect(ingestProblems(odd).join(' ')).toMatch(/issues list could not be read/)
  })

  it('names every skip and why, so nothing goes missing silently', () => {
    const problems = ingestProblems(broken)
    expect(problems.length).toBe(3)
    expect(problems.join(' ')).toMatch(/issue/i)
    expect(problems.join(' ')).toMatch(/repo/i)
  })
})
