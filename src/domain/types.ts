/**
 * The vocabulary the whole app is written in.
 *
 * Plain shapes, no methods. Every behaviour is a pure function sitting beside
 * them (see `derive.ts`). This file imports nothing; everything else imports it.
 *
 * Note what is absent: no `bucket` field on Ticket (#4 — buckets are derived)
 * and no position on anything (#15 — positions are derived). Stored truth stops
 * at `DomainGraph`.
 */

/** A ticket's identity: `"owner/repo#123"`. Repo plus number, globally unique. */
export type TicketKey = string

/** The four workflow columns (#3). Fixed — blocked is styling, never a column. */
export type Bucket = 'tickets' | 'in-progress' | 'in-review' | 'done'

/** A pull request attached to a ticket. Folded into the ticket, never its own node (#6). */
export interface PullRef {
  number: number
  state: 'open' | 'merged' | 'closed'
  /** Drives the attention lens (#8), never the bucket. */
  awaitingReview: boolean
  url: string
}

/** One GitHub issue. */
export interface Ticket {
  key: TicketKey
  title: string
  state: 'open' | 'closed'
  assignee: string | null
  /** `human-gated` lives here as a plain label (#8) — no inference. */
  labels: string[]
  prs: PullRef[]
  url: string
}

/** One native blocked-by relation (#5). Named so that swapping the ends reads as wrong. */
export interface Edge {
  blocked: TicketKey
  by: TicketKey
}

/** The whole of stored truth. Anything not in here is computed on demand. */
export interface DomainGraph {
  tickets: Ticket[]
  edges: Edge[]
}

/** The repo half of a key: `"owner/repo#123"` → `"owner/repo"`. Picks the lane (#7). */
export const repoOf = (key: TicketKey): string => {
  const hash = key.lastIndexOf('#')
  return hash === -1 ? key : key.slice(0, hash)
}
