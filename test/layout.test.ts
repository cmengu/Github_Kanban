import { describe, expect, it } from 'vitest'
import { bucketOf, waves } from '../src/domain/derive'
import { layout } from '../src/layout/layout'
import type { DomainGraph } from '../src/domain/types'
import { repoOf } from '../src/domain/types'
import { graph, shuffle, ticket } from './helpers'

/**
 * Two lanes so lane containment and cross-lane edges are exercised.
 *
 *   o/alpha:  a1 → a2
 *   o/zulu :  z1 → z2,  z3 standing alone,  a1 → z3 (crosses the lane border)
 */
const fixture = (): DomainGraph =>
  graph(
    [
      ticket('o/alpha#1'),
      ticket('o/alpha#2'),
      ticket('o/zulu#1'),
      ticket('o/zulu#2'),
      ticket('o/zulu#3'),
    ],
    [
      { blocked: 'o/alpha#2', by: 'o/alpha#1' },
      { blocked: 'o/zulu#2', by: 'o/zulu#1' },
    ],
  )

describe('determinism — the foundation #15 stands on', () => {
  it('gives byte-identical positions when called twice', () => {
    const g = fixture()
    expect(layout(g, 'map')).toEqual(layout(g, 'map'))
    expect(layout(g, 'board')).toEqual(layout(g, 'board'))
  })

  it('does not depend on the order tickets and edges arrive in', () => {
    const g = fixture()
    const shuffled: DomainGraph = { tickets: shuffle(g.tickets), edges: shuffle(g.edges) }
    expect(layout(shuffled, 'map').pos).toEqual(layout(g, 'map').pos)
    expect(layout(shuffled, 'board').pos).toEqual(layout(g, 'board').pos)
  })
})

describe('every ticket gets placed', () => {
  it('produces one node and one position per ticket', () => {
    const g = fixture()
    const l = layout(g, 'map')
    expect(l.nodes).toHaveLength(g.tickets.length)
    expect(Object.keys(l.pos).sort()).toEqual(g.tickets.map((t) => t.key).sort())
  })

  it('never puts two tickets on the same pixel', () => {
    const l = layout(fixture(), 'map')
    const seen = new Set(l.nodes.map((n) => `${n.x},${n.y}`))
    expect(seen.size).toBe(l.nodes.length)
  })

  it('reports a canvas big enough to contain every node', () => {
    const l = layout(fixture(), 'map')
    for (const n of l.nodes) {
      expect(n.x + n.r).toBeLessThanOrEqual(l.width)
      expect(n.y + n.r).toBeLessThanOrEqual(l.height)
      expect(n.x - n.r).toBeGreaterThanOrEqual(0)
      expect(n.y - n.r).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('bands — the only thing the two views disagree about', () => {
  it('board view orders columns Tickets → In progress → In review → Done', () => {
    const g = graph([
      ticket('o/r#1'),
      ticket('o/r#2', { assignee: 'cmengu' }),
      ticket('o/r#3', { prs: [{ number: 1, state: 'open', awaitingReview: true, url: 'u' }] }),
      ticket('o/r#4', { state: 'closed' }),
    ])
    const byKey = new Map(layout(g, 'board').nodes.map((n) => [n.key, n]))
    const x = (k: string): number => byKey.get(k)!.x

    expect(x('o/r#1')).toBeLessThan(x('o/r#2'))
    expect(x('o/r#2')).toBeLessThan(x('o/r#3'))
    expect(x('o/r#3')).toBeLessThan(x('o/r#4'))
    for (const t of g.tickets) expect(byKey.get(t.key)!.bucket).toBe(bucketOf(t))
  })

  it('map view places a ticket by its wave, and equal waves share a column', () => {
    const g = fixture()
    const w = waves(g)
    const nodes = layout(g, 'map').nodes

    for (const n of nodes) expect(n.wave).toBe(w.get(n.key))

    const xByWave = new Map<number, number>()
    for (const n of nodes) {
      const seen = xByWave.get(n.wave)
      if (seen === undefined) xByWave.set(n.wave, n.x)
      else expect(n.x).toBe(seen)
    }
    expect(xByWave.get(1)!).toBeLessThan(xByWave.get(2)!)
  })
})

describe('lanes — one per repo, and nothing leaves its own (#7)', () => {
  it('gives every repo a lane, heaviest first, ties broken by name', () => {
    const l = layout(fixture(), 'map')
    // Both lanes gate one open ticket, so the tie falls back to the name.
    expect(l.lanes.map((lane) => lane.repo)).toEqual(['o/alpha', 'o/zulu'])
    expect(l.lanes.map((lane) => lane.weight)).toEqual([1, 1])
  })

  it('puts the project gating the most open work on top', () => {
    const g = fixture()
    g.tickets.push(ticket('o/zulu#4'), ticket('o/zulu#5'))
    g.edges.push({ blocked: 'o/zulu#4', by: 'o/zulu#1' }, { blocked: 'o/zulu#5', by: 'o/zulu#1' })

    const l = layout(g, 'map')
    expect(l.lanes[0]!.repo).toBe('o/zulu')
    expect(l.lanes[0]!.weight).toBeGreaterThan(l.lanes[1]!.weight)
  })

  it('keeps every node inside its repo lane in both views', () => {
    for (const view of ['board', 'map'] as const) {
      const l = layout(fixture(), view)
      const laneOf = new Map(l.lanes.map((lane) => [lane.repo, lane]))
      for (const n of l.nodes) {
        const lane = laneOf.get(repoOf(n.key))!
        expect(n.lane).toBe(lane.repo)
        expect(n.y - n.r).toBeGreaterThanOrEqual(lane.y)
        expect(n.y + n.r).toBeLessThanOrEqual(lane.y + lane.height)
      }
    }
  })
})

describe('edges — drawn, ready, and pointed at the blocker', () => {
  it('emits one path per edge, starting at the blocker', () => {
    const l = layout(fixture(), 'map')
    expect(l.paths).toHaveLength(2)
    for (const p of l.paths) {
      expect(p.d.startsWith('M ')).toBe(true)
      const from = l.pos[p.by]!
      expect(p.d).toContain(`M ${from.x} ${from.y}`)
    }
  })

  it('puts the dot near the blocker end, not the middle', () => {
    const l = layout(fixture(), 'map')
    const p = l.paths.find((e) => e.blocked === 'o/alpha#2')!
    const blocker = l.pos['o/alpha#1']!
    const blocked = l.pos['o/alpha#2']!
    const toBlocker = Math.hypot(p.dot.x - blocker.x, p.dot.y - blocker.y)
    const toBlocked = Math.hypot(p.dot.x - blocked.x, p.dot.y - blocked.y)
    expect(toBlocker).toBeLessThan(toBlocked)
  })

  it('drops an edge whose blocker was never loaded, instead of drawing into nowhere', () => {
    const g = graph([ticket('o/r#1')], [{ blocked: 'o/r#1', by: 'never/loaded#7' }])
    expect(layout(g, 'map').paths).toEqual([])
  })

  it('flags the edges that cross a lane border, so they can be drawn loud', () => {
    const g = fixture()
    g.edges.push({ blocked: 'o/zulu#3', by: 'o/alpha#1' })
    const paths = layout(g, 'map').paths
    expect(paths.find((p) => p.blocked === 'o/zulu#3')!.crossLane).toBe(true)
    expect(paths.find((p) => p.blocked === 'o/alpha#2')!.crossLane).toBe(false)
  })

  it('marks whether the blocker is still open, so blocked edges can bead and drift', () => {
    const g = fixture()
    const open = layout(g, 'map').paths.find((p) => p.blocked === 'o/zulu#2')!
    expect(open.blockerOpen).toBe(true)

    g.tickets = g.tickets.map((t) => (t.key === 'o/zulu#1' ? { ...t, state: 'closed' as const } : t))
    const settled = layout(g, 'map').paths.find((p) => p.blocked === 'o/zulu#2')!
    expect(settled.blockerOpen).toBe(false)
  })
})

describe('columns — a column says what it means (#3)', () => {
  it('names the four board columns in workflow order', () => {
    const l = layout(fixture(), 'board')
    expect(l.columns.map((c) => c.label)).toEqual(['Tickets', 'In progress', 'In review', 'Done'])
  })

  it('names the star map columns by distance from startable', () => {
    const l = layout(fixture(), 'map')
    expect(l.columns.map((c) => c.label)).toEqual(['Done', 'Ready now', '1 away'])
  })

  it('puts each heading over its own column', () => {
    const l = layout(fixture(), 'map')
    const byBand = new Map(l.columns.map((c) => [c.band, c.x]))
    for (const n of l.nodes) expect(byBand.get(n.band)).toBe(n.x)
  })
})

describe('orb weight — size carries importance, not rank (#8)', () => {
  it('makes a ticket that gates more work strictly bigger', () => {
    const g = graph(
      [ticket('o/r#1'), ticket('o/r#2'), ticket('o/r#3')],
      [
        { blocked: 'o/r#2', by: 'o/r#1' },
        { blocked: 'o/r#3', by: 'o/r#2' },
      ],
    )
    const byKey = new Map(layout(g, 'map').nodes.map((n) => [n.key, n]))
    expect(byKey.get('o/r#1')!.r).toBeGreaterThan(byKey.get('o/r#2')!.r)
    expect(byKey.get('o/r#2')!.r).toBeGreaterThan(byKey.get('o/r#3')!.r)
  })

  it('gives a ring to every linked PR, whatever its state (#6)', () => {
    const g = graph([
      ticket('o/r#1', {
        prs: [
          { number: 1, state: 'merged', awaitingReview: false, url: 'u1' },
          { number: 2, state: 'open', awaitingReview: true, url: 'u2' },
        ],
      }),
      ticket('o/r#2'),
    ])
    const byKey = new Map(layout(g, 'map').nodes.map((n) => [n.key, n]))
    expect(byKey.get('o/r#1')!.rings).toBe(2)
    expect(byKey.get('o/r#2')!.rings).toBe(0)
  })
})

describe('delta stability — #15 proved before any motion exists', () => {
  it('moves exactly the tickets the change touched, and nothing else', () => {
    const before = layout(fixture(), 'map')

    const changed = fixture()
    changed.tickets = changed.tickets.map((t) =>
      t.key === 'o/zulu#1' ? { ...t, state: 'closed' as const } : t,
    )
    const after = layout(changed, 'map')

    const moved = Object.keys(before.pos)
      .filter((k) => JSON.stringify(before.pos[k]) !== JSON.stringify(after.pos[k]))
      .sort()

    // z1 falls back to wave 0; z2 becomes ready now. Everything else is untouched
    // — including z3, which shares a column with z2 but keeps its row.
    expect(moved).toEqual(['o/zulu#1', 'o/zulu#2'])
    expect(after.pos['o/alpha#1']).toEqual(before.pos['o/alpha#1'])
    expect(after.pos['o/alpha#2']).toEqual(before.pos['o/alpha#2'])
    expect(after.pos['o/zulu#3']).toEqual(before.pos['o/zulu#3'])
  })
})
