/**
 * What GitHub sends — deliberately NOT our vocabulary.
 *
 * These shapes mirror the GraphQL response exactly, connection wrappers and
 * all: shouty states like `'OPEN'`, a list of assignees rather than one, field
 * names like `nameWithOwner`, and every list buried under `{ nodes: [...] }`.
 * None of these words are allowed past `ingest.ts`, which is what makes a
 * GitHub field rename a one-file problem.
 *
 * The recorded fixture in `../fixtures/payloads/` is the untouched response
 * from this exact query, so these types are checked against real data rather
 * than against what we imagined the API returns.
 */

/** GraphQL wraps every list like this. Kept verbatim rather than flattened. */
export interface Connection<T> {
  nodes: T[]
}

/** How GitHub points at an issue in some repo. */
export interface IssueRef {
  number: number
  repository: { nameWithOwner: string }
}

export interface IssuePayload {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED'
  url: string
  assignees: Connection<{ login: string }>
  labels: Connection<{ name: string }>
  /** Native blocked-by relations (#5). */
  blockedBy: Connection<IssueRef>
}

export interface PullPayload {
  number: number
  title: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  url: string
  isDraft: boolean
  reviewDecision: 'REVIEW_REQUIRED' | 'APPROVED' | 'CHANGES_REQUESTED' | null
  /** Empty means the PR closes nothing — an orphan (#6, story 15). */
  closingIssuesReferences: Connection<IssueRef>
}

export interface RepoPayload {
  nameWithOwner: string
  issues: Connection<IssuePayload>
  pullRequests: Connection<PullPayload>
}

/** One poll's worth of data: the unit `toDomainGraph` consumes. */
export interface Snapshot {
  repos: RepoPayload[]
}
