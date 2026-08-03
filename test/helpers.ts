import type { DomainGraph, PullRef, Ticket, TicketKey } from '../src/domain/types'

/** Build a ticket with sane defaults; override only what the test is about. */
export function ticket(key: TicketKey, over: Partial<Ticket> = {}): Ticket {
  return {
    key,
    title: `ticket ${key}`,
    state: 'open',
    assignee: null,
    labels: [],
    prs: [],
    url: `https://github.com/${key.replace('#', '/issues/')}`,
    ...over,
  }
}

export function pr(over: Partial<PullRef> = {}): PullRef {
  return { number: 1, state: 'open', awaitingReview: false, url: 'https://example.invalid/pr/1', ...over }
}

export function graph(tickets: Ticket[], edges: DomainGraph['edges'] = []): DomainGraph {
  return { tickets, edges }
}

/** Deterministic shuffle (seeded), so "order must not matter" tests never flake. */
export function shuffle<T>(items: readonly T[], seed = 7): T[] {
  const out = items.slice()
  let s = seed
  const rand = (): number => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const a = out[i] as T
    const b = out[j] as T
    out[i] = b
    out[j] = a
  }
  return out
}
