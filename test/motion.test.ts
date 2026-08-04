/**
 * @vitest-environment jsdom
 *
 * The fifth pinned seam: the difference between two layouts, the schedule made
 * from it, and the replay driven by a fake clock. No test here waits on a real
 * animation frame — a suite whose result depends on wall time is not a test,
 * it is a stopwatch.
 *
 * The two halves are tested differently on purpose. `diffLayouts` and `plan`
 * are pure, so they are asserted exactly. `play` is asserted only on what must
 * be true of the DOM: it starts displaced, it ends clean, and interrupting it
 * lands on the truth the renderer already mounted.
 */

import { describe, expect, it } from 'vitest'
import { demo } from '../src/fixtures/demo'
import { layout } from '../src/layout/layout'
import { mount } from '../src/render/scene'
import { diffLayouts } from '../src/motion/delta'
import { plan, play, snapshotExits } from '../src/motion/choreo'
import { graph, ticket } from './helpers'
import type { DomainGraph } from '../src/domain/types'

const scene = (): SVGSVGElement => document.createElementNS('http://www.w3.org/2000/svg', 'svg')

/** A chain of three, so closing the first pulls the other two forward. */
const chain = (): DomainGraph =>
  graph(
    [ticket('o/r#1'), ticket('o/r#2'), ticket('o/r#3')],
    [
      { blocked: 'o/r#2', by: 'o/r#1' },
      { blocked: 'o/r#3', by: 'o/r#2' },
    ],
  )

const close = (g: DomainGraph, key: string): DomainGraph => ({
  ...g,
  tickets: g.tickets.map((t) => (t.key === key ? { ...t, state: 'closed' as const } : t)),
})

/** A hand-cranked animation clock: frames happen when the test says so. */
const fakeRaf = (): { raf: (fn: (t: number) => void) => number; caf: (id: number) => void; at: (t: number) => void; cancelled: number[] } => {
  let pending: ((t: number) => void) | null = null
  const cancelled: number[] = []
  return {
    raf: (fn) => {
      pending = fn
      return 1
    },
    caf: (id) => void cancelled.push(id),
    at: (t) => {
      const fn = pending
      pending = null
      fn?.(t)
    },
    cancelled,
  }
}

// ------------------------------------------------------------------ the delta

describe('diffLayouts — the change, as a value', () => {
  it('finds nothing at all between a layout and itself', () => {
    const l = layout(demo, 'map')
    const d = diffLayouts(l, l)

    expect(d.entered).toEqual([])
    expect(d.exited).toEqual([])
    expect(d.moved).toEqual([])
    expect(d.still).toHaveLength(l.nodes.length)

    // And nothing to replay: a poll that changed nothing must not cost a frame.
    expect(plan(d)).toEqual({ cues: [], total: 0 })
  })

  it('accounts for every node of both layouts exactly once', () => {
    const before = layout(chain(), 'map')
    const after = layout(close(chain(), 'o/r#1'), 'map')
    const d = diffLayouts(before, after)

    const named = [...d.entered.map((n) => n.key), ...d.moved.map((m) => m.key), ...d.still]
    expect(named.slice().sort()).toEqual(after.nodes.map((n) => n.key).sort())
    expect([...named, ...d.exited.map((n) => n.key)].sort()).toEqual(
      [...new Set([...before.nodes.map((n) => n.key), ...after.nodes.map((n) => n.key)])].sort(),
    )
  })

  it('moves only what the closed ticket touched, and says where from and to', () => {
    const before = layout(chain(), 'map')
    const after = layout(close(chain(), 'o/r#1'), 'map')
    const d = diffLayouts(before, after)

    // #1 falls back to the Done pile, #2 becomes ready now, #3 follows it in.
    expect(d.moved.map((m) => m.key).sort()).toEqual(['o/r#1', 'o/r#2', 'o/r#3'])
    for (const m of d.moved) {
      expect(m.from).toEqual(before.pos[m.key])
      expect(m.to).toEqual(after.pos[m.key])
    }
  })

  it('carries the radius, so a star that stops gating work shrinks as it travels', () => {
    const before = layout(chain(), 'map')
    const after = layout(close(chain(), 'o/r#1'), 'map')
    const closed = diffLayouts(before, after).moved.find((m) => m.key === 'o/r#1')!

    // #1 gated two open tickets and now gates none — the size is part of the move.
    expect(closed.fromR).toBeGreaterThan(closed.toR)
    expect(closed.toR).toBe(after.nodes.find((n) => n.key === 'o/r#1')!.r)
  })

  it('reports an arrival and a departure, not a move, when the graph changes shape', () => {
    const g = chain()
    const grown: DomainGraph = { ...g, tickets: [...g.tickets, ticket('o/r#4')] }
    const d = diffLayouts(layout(g, 'map'), layout(grown, 'map'))
    expect(d.entered.map((n) => n.key)).toEqual(['o/r#4'])
    expect(d.exited).toEqual([])

    const back = diffLayouts(layout(grown, 'map'), layout(g, 'map'))
    expect(back.exited.map((n) => n.key)).toEqual(['o/r#4'])
    expect(back.entered).toEqual([])
  })

  it('creates and destroys nothing when the view flips — the same stars, rearranged', () => {
    const d = diffLayouts(layout(demo, 'map'), layout(demo, 'board'))

    expect(d.entered).toEqual([])
    expect(d.exited).toEqual([])
    expect(d.moved.length).toBeGreaterThan(0)
  })
})

// ----------------------------------------------------------------- the plan

describe('plan — the schedule, before anything is drawn', () => {
  const deltaOf = (): ReturnType<typeof diffLayouts> =>
    diffLayouts(layout(chain(), 'map'), layout(close(chain(), 'o/r#1'), 'map'))

  it('gives one cue per changed node and nothing for what held still', () => {
    const d = deltaOf()
    const p = plan(d)
    expect(p.cues).toHaveLength(d.entered.length + d.exited.length + d.moved.length)
    for (const key of d.still) expect(p.cues.some((c) => c.key === key)).toBe(false)
  })

  it('staggers the movers into a cascade instead of one synchronised jump', () => {
    const p = plan(deltaOf())
    const starts = p.cues.filter((c) => c.act === 'move').map((c) => c.at)
    expect(new Set(starts).size).toBe(starts.length)
    expect(Math.max(...starts)).toBeGreaterThan(Math.min(...starts))
  })

  it('lets leavers go first and arrivals come last', () => {
    const g = chain()
    const swapped: DomainGraph = { ...g, tickets: [...g.tickets.slice(1), ticket('o/r#9')] }
    const p = plan(diffLayouts(layout(g, 'map'), layout(swapped, 'map')))

    const at = (act: string): number[] => p.cues.filter((c) => c.act === act).map((c) => c.at)
    expect(Math.min(...at('exit'))).toBe(0)
    // Arrivals start only once every mover has finished — nothing fades in on
    // top of a star still sliding out of that spot.
    const movesEnd = Math.max(...p.cues.filter((c) => c.act === 'move').map((c) => c.at + c.dur))
    expect(Math.min(...at('enter'))).toBeGreaterThanOrEqual(movesEnd)
  })

  it('starts the cascade at Done, whichever side of the canvas Done is on', () => {
    const d = deltaOf()
    const first = (side: 'left' | 'right'): string =>
      plan(d, { doneSide: side })
        .cues.filter((c) => c.act === 'move')
        .sort((a, b) => a.at - b.at)[0]!.key

    // #1 is the ticket that closed and drops into the pile; on the star map the
    // pile is on the left, on the board it is the last column, and the ripple
    // sets off from it either way.
    expect(first('left')).toBe('o/r#1')
    expect(first('right')).toBe('o/r#3')
  })

  it('keeps the whole glide short however many stars move', () => {
    const many = graph(Array.from({ length: 200 }, (_, i) => ticket(`o/r#${i + 1}`)))
    const moved = graph(many.tickets.map((t) => ({ ...t, state: 'closed' as const })))
    const p = plan(diffLayouts(layout(many, 'map'), layout(moved, 'map')))

    expect(p.cues.filter((c) => c.act === 'move')).toHaveLength(200)
    expect(p.total).toBeLessThan(1200)
  })

  it('zeroes every duration when the reader asked for less motion', () => {
    const p = plan(deltaOf(), { reduced: true })
    expect(p.total).toBe(0)
    for (const c of p.cues) expect([c.at, c.dur]).toEqual([0, 0])
  })

  it('plans the same schedule twice for the same change', () => {
    expect(plan(deltaOf())).toEqual(plan(deltaOf()))
  })
})

// ----------------------------------------------------------------- the replay

describe('play — a memory laid over a scene that is already true', () => {
  /** Mount `after`, exactly as main.ts does, and hand back everything play needs. */
  const staged = (before: DomainGraph, after: DomainGraph) => {
    const svg = scene()
    const from = layout(before, 'map')
    mount(svg, before, from)

    const to = layout(after, 'map')
    const d = diffLayouts(from, to)
    const ghosts = snapshotExits(svg, d)
    mount(svg, after, to)
    return { svg, from, to, d, ghosts }
  }

  it('starts every mover displaced back to where it was, before any frame runs', () => {
    const { svg, from, to, d, ghosts } = staged(chain(), close(chain(), 'o/r#1'))
    const clock = fakeRaf()
    play(svg, from, to, plan(d), ghosts, clock)

    const el = svg.querySelector<SVGGElement>('g.node[data-key="o/r#2"]')!
    // Mounted at its destination, shoved back by exactly the distance travelled.
    expect(el.getAttribute('transform')).toBe(`translate(${to.pos['o/r#2']!.x} ${to.pos['o/r#2']!.y})`)
    const dx = from.pos['o/r#2']!.x - to.pos['o/r#2']!.x
    expect(el.style.transform).toBe(`translate(${dx}px, ${from.pos['o/r#2']!.y - to.pos['o/r#2']!.y}px)`)
  })

  it('clears every trace of itself once the last cue is over', () => {
    const { svg, from, to, d, ghosts } = staged(chain(), close(chain(), 'o/r#1'))
    const clock = fakeRaf()
    const p = plan(d)
    play(svg, from, to, p, ghosts, clock)

    clock.at(0)
    clock.at(p.total + 1)

    for (const el of svg.querySelectorAll<SVGGElement>('g.node')) expect(el.style.transform).toBe('')
    expect(svg.querySelectorAll('g.ghosts')).toHaveLength(0)
  })

  it('snaps to the mounted truth when a poll interrupts it mid-flight', () => {
    const { svg, from, to, d, ghosts } = staged(chain(), close(chain(), 'o/r#1'))
    const clock = fakeRaf()
    const p = plan(d)
    const cancel = play(svg, from, to, p, ghosts, clock)

    clock.at(0)
    clock.at(p.total / 2) // caught halfway
    cancel()

    for (const el of svg.querySelectorAll<SVGGElement>('g.node')) expect(el.style.transform).toBe('')
    // Every edge is back on the curve the layout computed, not one frame short of it.
    for (const path of to.paths) {
      const line = svg.querySelector(`g.edge[data-blocked="${path.blocked}"][data-by="${path.by}"] .edge-line`)
      expect(line!.getAttribute('d')).toBe(path.d)
    }
    expect(clock.cancelled).toHaveLength(1)
  })

  it('keeps edges attached to their stars while they travel', () => {
    const { svg, from, to, d, ghosts } = staged(chain(), close(chain(), 'o/r#1'))
    const clock = fakeRaf()
    const p = plan(d)
    play(svg, from, to, p, ghosts, clock)
    clock.at(0)

    const path = to.paths.find((e) => e.blocked === 'o/r#3')!
    const line = svg.querySelector(
      `g.edge[data-blocked="${path.blocked}"][data-by="${path.by}"] .edge-line`,
    )!
    // At t=0 the curve must join the *old* positions, not the mounted ones.
    expect(line.getAttribute('d')).toContain(`M ${from.pos[path.by]!.x} ${from.pos[path.by]!.y}`)
    expect(line.getAttribute('d')).not.toBe(path.d)
  })

  it('shows the leavers leaving, then takes them away', () => {
    const g = chain()
    const smaller: DomainGraph = { ...g, tickets: g.tickets.filter((t) => t.key !== 'o/r#3'), edges: [] }
    const { svg, from, to, d, ghosts } = staged(g, smaller)

    expect(ghosts).toHaveLength(1)
    // A ghost is a picture, not a ticket: nothing can hover it or click through it.
    expect(ghosts[0]!.getAttribute('data-key')).toBeNull()
    expect(svg.querySelectorAll('g.node[data-key="o/r#3"]')).toHaveLength(0)

    const clock = fakeRaf()
    const p = plan(d)
    play(svg, from, to, p, ghosts, clock)
    clock.at(0)
    expect(svg.querySelectorAll('g.ghosts g.node')).toHaveLength(1)

    clock.at(p.total + 1)
    expect(svg.querySelectorAll('g.ghosts')).toHaveLength(0)
  })

  it('draws the destination and stops when the reader asked for less motion', () => {
    const { svg, from, to, d, ghosts } = staged(chain(), close(chain(), 'o/r#1'))
    const clock = fakeRaf()
    play(svg, from, to, plan(d, { reduced: true }), ghosts, clock)

    // Not one frame was asked for, and the scene is already correct.
    clock.at(0)
    for (const el of svg.querySelectorAll<SVGGElement>('g.node')) expect(el.style.transform).toBe('')
    expect(svg.querySelectorAll('g.ghosts')).toHaveLength(0)
  })
})

// ------------------------------------------------------- the Done pile packs

describe('the Done pile packs (decision 4)', () => {
  it('leaves a graph with no finished work exactly on the old row grid', () => {
    const g = chain()
    const l = layout(g, 'board')
    const lane = l.lanes[0]!

    // Step 3's arithmetic, restated: rows of 74 starting 48 from the top,
    // columns of 190 starting 60 from the left, a lane exactly as tall as its
    // fullest column, a canvas one pad wider than the last column. Packing is
    // inert until there is something finished to pack, so with nothing closed
    // every one of these still holds to the pixel.
    expect(l.nodes).toHaveLength(3)
    expect(lane.y).toBe(48)
    for (const n of l.nodes) {
      expect((n.y - lane.y - 37) % 74).toBe(0)
      expect((n.x - 60) % 190).toBe(0)
    }
    const tallest = Math.max(...l.columns.map((c) => l.nodes.filter((n) => n.band === c.band).length))
    expect(lane.height).toBe(tallest * 74)
    expect(l.height).toBe(lane.y + lane.height + 48)
    expect(l.width).toBe(60 * 2 + 3 * 190)
  })

  it('compresses the fixture from a scroll of history into a corner of it', () => {
    const l = layout(demo, 'map')
    const done = demo.tickets.filter((t) => t.state === 'closed')

    expect(done.length).toBeGreaterThan(8)
    // 14 finished tickets used to cost 14 full rows; now they cost four short ones.
    expect(l.height).toBeLessThan(400)
    const rows = new Set(l.nodes.filter((n) => done.some((t) => t.key === n.key)).map((n) => n.y))
    expect(rows.size).toBe(Math.ceil(done.length / 4))
  })

  it('keeps every packed star inside its lane and on the canvas', () => {
    for (const view of ['map', 'board'] as const) {
      const l = layout(demo, view)
      const laneOf = new Map(l.lanes.map((lane) => [lane.repo, lane]))
      for (const n of l.nodes) {
        const lane = laneOf.get(n.lane)!
        expect(n.y - n.r).toBeGreaterThanOrEqual(lane.y)
        expect(n.y + n.r).toBeLessThanOrEqual(lane.y + lane.height)
        expect(n.x - n.r).toBeGreaterThanOrEqual(0)
        expect(n.x + n.r).toBeLessThanOrEqual(l.width)
      }
    }
  })

  it('still puts no two stars on the same pixel', () => {
    for (const view of ['map', 'board'] as const) {
      const l = layout(demo, view)
      expect(new Set(l.nodes.map((n) => `${n.x},${n.y}`)).size).toBe(l.nodes.length)
    }
  })
})
