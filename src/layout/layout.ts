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

import { bucketOf, frontier, gatedCount, indexOf, waves } from '../domain/derive'
import type { Bucket, DomainGraph, TicketKey } from '../domain/types'
import { repoOf } from '../domain/types'

export type View = 'board' | 'map'

export interface Point {
  x: number
  y: number
}

export interface LayoutNode {
  key: TicketKey
  /**
   * What this node is (step 3). A `'pull'` is an orphan pull request standing
   * in its lane's strip: the ticket-ish fields below are zeroed on it, and the
   * renderer branches on this rather than guessing from the key's punctuation.
   */
  kind: 'ticket' | 'pull'
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
  y: number
  height: number
  /** Total open work this repo's tickets gate — what orders the lanes (#7). */
  weight: number
  /**
   * Where this lane's strip of unattached pull requests sits (step 3), or
   * `null` when the lane has none — so a lane without orphans is exactly as
   * tall as it was before.
   */
  pullStripY: number | null
}

/** One column heading: which band, where, and what to call it. */
export interface Column {
  band: number
  x: number
  label: string
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
  columns: Column[]
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
/** The orphan-PR strip (step 3): fixed ring size, fixed spacing, one thin row. */
const PULL_STRIP_H = 34
const PULL_GAP = 56
const R_PULL = 7
/** How far along the curve the blocker-end dot sits. */
const DOT_T = 0.06

/** The four board columns, in workflow order (#3). */
const BOARD_BANDS: Bucket[] = ['tickets', 'in-progress', 'in-review', 'done']
const BOARD_LABELS = ['Tickets', 'In progress', 'In review', 'Done']

/** What a star map column means: 0 is finished, 1 is startable, then hand-offs. */
const waveLabel = (band: number): string =>
  band === 0 ? 'Done' : band === 1 ? 'Ready now' : `${band - 1} away`

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
  const frontierSet = new Set(frontier(g, ix))
  const gatedByKey = new Map(g.tickets.map((t) => [t.key, gatedCount(g, t.key, ix)]))

  // ---- lanes, heaviest first, so the project needing attention sits on top
  // (#7). Ties break on name, so the order is still a pure function of the data.
  const weightOf = (repo: string): number =>
    g.tickets
      .filter((t) => repoOf(t.key) === repo)
      .reduce((sum, t) => sum + (gatedByKey.get(t.key) ?? 0), 0)

  // A repo can appear with only orphan pulls and no tickets — it still gets a
  // lane, or the work step 2 kept would be invisible again (step 3, story 15).
  const repos = [...new Set([...g.tickets.map((t) => repoOf(t.key)), ...g.pulls.map((p) => p.repo)])].sort()
  const laneWeight = new Map(repos.map((repo) => [repo, weightOf(repo)]))
  repos.sort((a, b) => (laneWeight.get(b) ?? 0) - (laneWeight.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0))

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

  // Orphan pulls per lane, key-sorted so their strip order is stable (step 3).
  const pullsByRepo = new Map<string, typeof g.pulls>()
  for (const p of [...g.pulls].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
    const list = pullsByRepo.get(p.repo)
    if (list) list.push(p)
    else pullsByRepo.set(p.repo, [p])
  }

  let cursor = PAD_Y
  for (const repo of repos) {
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

    // The strip: a thin extra row along the bottom of the lane, only when the
    // lane has orphans — a lane without them is exactly as tall as in step 2.
    const orphans = pullsByRepo.get(repo) ?? []
    const rowsHeight = rows * ROW_H
    const pullStripY = orphans.length > 0 ? cursor + rowsHeight + PULL_STRIP_H / 2 : null
    if (pullStripY != null) {
      orphans.forEach((p, i) => {
        pos[p.key] = { x: PAD_X + i * PULL_GAP, y: pullStripY }
      })
    }

    const height = rowsHeight + (pullStripY != null ? PULL_STRIP_H : 0)
    lanes.push({ repo, y: cursor, height, weight: laneWeight.get(repo) ?? 0, pullStripY })
    cursor += height + LANE_GAP
  }

  // ---- nodes, in key order so the SVG is rebuilt the same way every time ----
  const nodes: LayoutNode[] = [...g.tickets]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((t) => {
      const at = pos[t.key] as Point
      const gated = gatedByKey.get(t.key) ?? 0
      const bucket = bucketOf(t)
      return {
        key: t.key,
        kind: 'ticket' as const,
        x: at.x,
        y: at.y,
        r: round(radiusOf(gated)),
        band: bandOf(view, bucket, waveByKey.get(t.key) ?? 0),
        lane: repoOf(t.key),
        bucket,
        wave: waveByKey.get(t.key) ?? 0,
        gated,
        frontier: frontierSet.has(t.key),
        blocked: (ix.blockers.get(t.key) ?? []).some((b) => ix.byKey.get(b)?.state === 'open'),
        done: t.state === 'closed',
        // Every linked PR is a ring in orbit, open or not — they stack (#6).
        rings: t.prs.length,
        humanGated: t.labels.includes('human-gated'),
      }
    })

  // Orphan pulls, after the tickets and in key order. The ticket-ish fields are
  // zeroed rather than invented: an unattached PR has no wave and no bucket,
  // which is exactly why it gets a strip instead of a column (decision 4).
  for (const [, orphans] of [...pullsByRepo.entries()].sort()) {
    orphans.forEach((p) => {
      const at = pos[p.key] as Point
      nodes.push({
        key: p.key,
        kind: 'pull',
        x: at.x,
        y: at.y,
        r: R_PULL,
        band: -1,
        lane: p.repo,
        bucket: 'tickets',
        wave: 0,
        gated: 0,
        frontier: false,
        blocked: false,
        done: p.state !== 'open',
        rings: 0,
        humanGated: false,
      })
    })
  }

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

  // ---- column headings, so a column says what it means (#3, story 4) ----
  const columns: Column[] = []
  for (let band = 0; band <= maxBand; band++) {
    columns.push({
      band,
      x: PAD_X + band * COL_W,
      label: view === 'board' ? (BOARD_LABELS[band] ?? '') : waveLabel(band),
    })
  }

  const lastLane = lanes[lanes.length - 1]
  // A long strip may stick out past the last column; the canvas must hold it.
  const widestStrip = Math.max(0, ...[...pullsByRepo.values()].map((list) => list.length))
  return {
    pos,
    nodes,
    lanes,
    columns,
    paths,
    width: Math.max(PAD_X * 2 + maxBand * COL_W, widestStrip > 0 ? PAD_X * 2 + (widestStrip - 1) * PULL_GAP : 0),
    height: lastLane ? lastLane.y + lastLane.height + PAD_Y : PAD_Y * 2,
  }
}
