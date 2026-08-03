/**
 * Graph in, positions out — the seam the whole app is built around (#13).
 *
 * Both projections come out of this one function, and the only thing they
 * disagree about is which column a ticket lands in: its bucket in `board`
 * view, its wave in `map` view. Everything else — lanes, stacking, orb size,
 * edge curves — is shared, which is what lets the flip animate later.
 *
 * Nothing here touches the screen, the clock, or a random number. That is what
 * makes the picture identical on every refresh, and delta stability free (#15).
 */

import { bucketOf, gatedCount, indexOf, waves } from '../domain/derive'
import type { Bucket, DomainGraph, TicketKey } from '../domain/types'
import { repoOf } from '../domain/types'

export type View = 'board' | 'map'

export interface Point {
  x: number
  y: number
}

export interface LayoutNode {
  key: TicketKey
  x: number
  y: number
  /** Orb radius, grown from how much open work this ticket gates (#8). */
  r: number
  /** Column index in the current view. */
  band: number
  /** The repo lane this node lives in — it never leaves it (#7). */
  lane: string
  bucket: Bucket
  wave: number
  gated: number
  /** Open, unclaimed, blockers all done — the pulsing "start here" set. */
  frontier: boolean
  /** At least one blocker still open. */
  blocked: boolean
  done: boolean
  /** Open PRs, drawn as rings in orbit (#6). */
  rings: number
  /** Carries the `human-gated` label (#8) — a manual convention, never inferred. */
  humanGated: boolean
}

export interface Lane {
  repo: string
  index: number
  y: number
  height: number
}

export interface EdgePath {
  blocked: TicketKey
  by: TicketKey
  /** A finished SVG path string, running from the blocker to the blocked ticket. */
  d: string
  /** Where the blocker-end dot sits, already on the curve. No arrowheads (#2). */
  dot: Point
  blockerOpen: boolean
  /** True when the edge leaves its lane — those are the loud ones (#7). */
  crossLane: boolean
}

export interface Layout {
  pos: Record<TicketKey, Point>
  nodes: LayoutNode[]
  lanes: Lane[]
  paths: EdgePath[]
  width: number
  height: number
}

const COL_W = 190
const ROW_H = 74
const PAD_X = 60
const PAD_Y = 48
const LANE_GAP = 40
const R_BASE = 9
const R_GROWTH = 5
const R_MAX = 30
/** How far along the curve the blocker-end dot sits. */
const DOT_T = 0.06

/** The four board columns, in workflow order (#3). */
const BOARD_BANDS: Bucket[] = ['tickets', 'in-progress', 'in-review', 'done']

/** The single expression the two views disagree about. */
const bandOf = (view: View, bucket: Bucket, wave: number): number =>
  view === 'board' ? BOARD_BANDS.indexOf(bucket) : wave

const radiusOf = (gated: number): number => Math.min(R_MAX, R_BASE + Math.sqrt(gated) * R_GROWTH)

/** A point on a cubic bezier, so the dot sits on the curve rather than beside it. */
const cubicAt = (t: number, p0: Point, p1: Point, p2: Point, p3: Point): Point => {
  const u = 1 - t
  const [a, b, c, d] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t]
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  }
}

const round = (n: number): number => Math.round(n * 100) / 100

export function layout(g: DomainGraph, view: View): Layout {
  const ix = indexOf(g)
  const waveByKey = waves(g, ix)
  const frontierSet = new Set(
    g.tickets
      .filter((t) => bucketOf(t) === 'tickets')
      .filter((t) => (ix.blockers.get(t.key) ?? []).every((b) => ix.byKey.get(b)?.state === 'closed'))
      .map((t) => t.key),
  )

  // ---- lanes, ordered by repo name so the order never drifts under a poll ----
  const repos = [...new Set(g.tickets.map((t) => repoOf(t.key)))].sort()

  // ---- which column and which lane each ticket lands in ----
  type Slot = { key: TicketKey; band: number; repo: string }
  const slots: Slot[] = g.tickets.map((t) => ({
    key: t.key,
    band: bandOf(view, bucketOf(t), waveByKey.get(t.key) ?? 0),
    repo: repoOf(t.key),
  }))

  const maxBand = view === 'board'
    ? BOARD_BANDS.length - 1
    : Math.max(0, ...slots.map((s) => s.band))

  // ---- stack each lane's columns, sorted by key so stacking is stable ----
  const lanes: Lane[] = []
  const pos: Record<TicketKey, Point> = {}
  const rowOf = new Map<TicketKey, number>()

  let cursor = PAD_Y
  repos.forEach((repo, index) => {
    const mine = slots.filter((s) => s.repo === repo)
    let rows = 1
    for (let band = 0; band <= maxBand; band++) {
      const column = mine
        .filter((s) => s.band === band)
        .map((s) => s.key)
        .sort()
      rows = Math.max(rows, column.length)
      column.forEach((key, row) => {
        rowOf.set(key, row)
        pos[key] = { x: PAD_X + band * COL_W, y: cursor + row * ROW_H + ROW_H / 2 }
      })
    }
    const height = rows * ROW_H
    lanes.push({ repo, index, y: cursor, height })
    cursor += height + LANE_GAP
  })

  // ---- nodes, in key order so the SVG is rebuilt the same way every time ----
  const nodes: LayoutNode[] = [...g.tickets]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((t) => {
      const at = pos[t.key] as Point
      const gated = gatedCount(g, t.key, ix)
      return {
        key: t.key,
        x: at.x,
        y: at.y,
        r: round(radiusOf(gated)),
        band: bandOf(view, bucketOf(t), waveByKey.get(t.key) ?? 0),
        lane: repoOf(t.key),
        bucket: bucketOf(t),
        wave: waveByKey.get(t.key) ?? 0,
        gated,
        frontier: frontierSet.has(t.key),
        blocked: (ix.blockers.get(t.key) ?? []).some((b) => ix.byKey.get(b)?.state === 'open'),
        done: t.state === 'closed',
        rings: t.prs.filter((p) => p.state === 'open').length,
        humanGated: t.labels.includes('human-gated'),
      }
    })

  // ---- edges, already curved and ready to draw ----
  const paths: EdgePath[] = []
  for (const key of [...ix.byKey.keys()].sort()) {
    for (const by of ix.blockers.get(key) ?? []) {
      const from = pos[by]
      const to = pos[key]
      if (!from || !to) continue

      // Bend along the direction the edge actually travels. In board view a
      // blocker often sits to the right of what it blocks, and a fixed
      // left-to-right bend would sling the curve off the canvas.
      const dir = to.x === from.x ? 1 : Math.sign(to.x - from.x)
      const bend = Math.max(30, Math.abs(to.x - from.x) * 0.45) * dir
      const c1: Point = { x: from.x + bend, y: from.y }
      const c2: Point = { x: to.x - bend, y: to.y }
      const dot = cubicAt(DOT_T, from, c1, c2, to)

      paths.push({
        blocked: key,
        by,
        d: `M ${from.x} ${from.y} C ${round(c1.x)} ${round(c1.y)}, ${round(c2.x)} ${round(c2.y)}, ${to.x} ${to.y}`,
        dot: { x: round(dot.x), y: round(dot.y) },
        blockerOpen: ix.byKey.get(by)?.state === 'open',
        crossLane: repoOf(key) !== repoOf(by),
      })
    }
  }

  const lastLane = lanes[lanes.length - 1]
  return {
    pos,
    nodes,
    lanes,
    paths,
    width: PAD_X * 2 + maxBand * COL_W,
    height: lastLane ? lastLane.y + lastLane.height + PAD_Y : PAD_Y * 2,
  }
}
