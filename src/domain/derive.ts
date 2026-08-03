/**
 * Every question you can ask the graph, answered without changing it.
 *
 * Decision #4 lives here: a ticket's bucket is computed, never stored. Every
 * function in this file is pure, so the whole module is testable with plain
 * objects and no browser.
 */

import type { Bucket, DomainGraph, Ticket, TicketKey } from './types'

/** Both directions of the edge list, plus a ticket lookup. Built once, passed around. */
export interface GraphIndex {
  byKey: Map<TicketKey, Ticket>
  /** key → the tickets it waits on. */
  blockers: Map<TicketKey, TicketKey[]>
  /** key → the tickets waiting on it. */
  dependents: Map<TicketKey, TicketKey[]>
}

/**
 * The #4 rule, and the only place the board's status comes from.
 * Closed wins, then an open PR, then an assignee, else it is unclaimed.
 */
export function bucketOf(t: Ticket): Bucket {
  if (t.state === 'closed') return 'done'
  if (t.prs.some((p) => p.state === 'open')) return 'in-review'
  if (t.assignee !== null) return 'in-progress'
  return 'tickets'
}

/**
 * Turns the flat edge list into something walkable in both directions.
 *
 * This is also the one place a dangling edge — a blocker in a repo that was
 * never loaded — is dropped, so no other function has to hold an opinion
 * about it. Neighbour lists are sorted and de-duplicated, which is what makes
 * everything downstream independent of the order GitHub returned things in.
 */
export function indexOf(g: DomainGraph): GraphIndex {
  const byKey = new Map<TicketKey, Ticket>()
  for (const t of g.tickets) byKey.set(t.key, t)

  const blockerSets = new Map<TicketKey, Set<TicketKey>>()
  const dependentSets = new Map<TicketKey, Set<TicketKey>>()
  for (const key of byKey.keys()) {
    blockerSets.set(key, new Set())
    dependentSets.set(key, new Set())
  }

  for (const e of g.edges) {
    if (e.blocked === e.by) continue
    const blocked = blockerSets.get(e.blocked)
    const by = dependentSets.get(e.by)
    if (!blocked || !by) continue // one end was never loaded — drop it here, once
    blocked.add(e.by)
    by.add(e.blocked)
  }

  const sorted = (sets: Map<TicketKey, Set<TicketKey>>): Map<TicketKey, TicketKey[]> => {
    const out = new Map<TicketKey, TicketKey[]>()
    for (const [key, set] of sets) out.set(key, [...set].sort())
    return out
  }

  return { byKey, blockers: sorted(blockerSets), dependents: sorted(dependentSets) }
}

/**
 * How far from startable every ticket is — the star map's horizontal axis.
 *
 * 0 = done, 1 = ready now, n = n hand-offs away. Finished blockers stop gating,
 * so closing one pulls its whole tail forward. Computed for all tickets at once
 * because layout needs every one of them.
 */
export function waves(g: DomainGraph, ix = indexOf(g)): Map<TicketKey, number> {
  const out = new Map<TicketKey, number>()
  const visiting = new Set<TicketKey>()

  const waveFor = (key: TicketKey): number => {
    const cached = out.get(key)
    if (cached !== undefined) return cached

    const t = ix.byKey.get(key)
    if (!t) return 0
    if (t.state === 'closed') {
      out.set(key, 0)
      return 0
    }
    // A cycle should never reach here from GitHub, but if it does the app must
    // still render. Treat the back-edge as ungated rather than recursing.
    if (visiting.has(key)) return 0

    visiting.add(key)
    let wave = 1
    for (const b of ix.blockers.get(key) ?? []) {
      const blocker = ix.byKey.get(b)
      if (!blocker || blocker.state === 'closed') continue
      wave = Math.max(wave, waveFor(b) + 1)
    }
    visiting.delete(key)

    out.set(key, wave)
    return wave
  }

  // Sorted, so that even a cyclic graph resolves the same way every time.
  for (const key of [...ix.byKey.keys()].sort()) waveFor(key)
  return out
}

/** One ticket's wave. The convenience wrapper over `waves`, for panels and tests. */
export const waveOf = (g: DomainGraph, key: TicketKey, ix?: GraphIndex): number =>
  waves(g, ix).get(key) ?? 0

/**
 * How many open tickets are stuck behind this one — the attention weight (#8),
 * and the number that becomes the star's size.
 *
 * Each downstream ticket counts once however many paths reach it, and the walk
 * stops at finished tickets: nothing behind a closed ticket is waiting on us.
 * A finished ticket therefore gates nothing itself — which is why done work
 * shrinks to a white dwarf instead of staying big.
 */
export function gatedCount(g: DomainGraph, key: TicketKey, ix = indexOf(g)): number {
  if (ix.byKey.get(key)?.state === 'closed') return 0

  const seen = new Set<TicketKey>()
  const stack = [...(ix.dependents.get(key) ?? [])]

  while (stack.length > 0) {
    const next = stack.pop()
    if (next === undefined || next === key || seen.has(next)) continue
    const t = ix.byKey.get(next)
    if (!t || t.state === 'closed') continue
    seen.add(next)
    stack.push(...(ix.dependents.get(next) ?? []))
  }

  return seen.size
}

/**
 * The "start here" set: open, unclaimed, every blocker finished. These are the
 * pulsing stars, and the answer to *what can an agent take right now*.
 */
export function frontier(g: DomainGraph, ix = indexOf(g)): TicketKey[] {
  return g.tickets
    .filter((t) => bucketOf(t) === 'tickets')
    .filter((t) => (ix.blockers.get(t.key) ?? []).every((b) => ix.byKey.get(b)?.state === 'closed'))
    .map((t) => t.key)
    .sort()
}

/**
 * Everything up-chain and down-chain of a ticket, including itself — what
 * lights up when you hover a star: the blocker trail behind it, and everything
 * waiting on it.
 */
export function chainOf(g: DomainGraph, key: TicketKey, ix = indexOf(g)): Set<TicketKey> {
  const out = new Set<TicketKey>()
  if (!ix.byKey.has(key)) return out
  out.add(key)

  for (const step of [ix.blockers, ix.dependents]) {
    const stack = [...(step.get(key) ?? [])]
    while (stack.length > 0) {
      const next = stack.pop()
      if (next === undefined || out.has(next)) continue
      out.add(next)
      stack.push(...(step.get(next) ?? []))
    }
  }

  return out
}
