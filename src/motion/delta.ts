/**
 * What changed between two pictures — as data, before it is motion.
 *
 * The animation could have been written as "diff the DOM and tween whatever
 * differs", and then the only way to ask *why did that star move* would have
 * been to watch it again. Instead the difference is a value: two layouts in, a
 * list of who arrived, who left, who moved and who held still out. It is pure,
 * so it is a unit test rather than a screen recording, and it is the same
 * object whether the change came from a poll, a view flip, or (step 5) a write
 * the app made itself.
 *
 * Nothing here knows about SVG, easing, or duration. That is `choreo.ts`.
 */

import type { Layout, LayoutNode, Point } from '../layout/layout'
import type { TicketKey } from '../domain/types'

export interface NodeMove {
  key: TicketKey
  kind: 'ticket' | 'pull'
  from: Point
  to: Point
  /** Radius before and after — a star that finishes shrinks as it travels. */
  fromR: number
  toR: number
}

export interface LayoutDelta {
  /** Nodes in the new layout that the old one had never heard of. */
  entered: LayoutNode[]
  /** Nodes the old layout had that are gone — carried as their *old* selves. */
  exited: LayoutNode[]
  moved: NodeMove[]
  /** Present in both, at the same place and the same size. */
  still: TicketKey[]
}

/** Sub-pixel differences are rounding, not movement, and must not animate. */
const EPS = 0.01
const same = (a: number, b: number): boolean => Math.abs(a - b) < EPS

/**
 * The difference between two layouts. Every node of both is accounted for in
 * exactly one of the four lists, which is the property the tests lean on: a
 * delta that quietly dropped a star would be a star that never animates and
 * never gets explained.
 *
 * Order follows the layouts' own node order (already key-sorted upstream), so
 * the same change always produces the same delta — and therefore the same
 * choreography.
 */
export function diffLayouts(prev: Layout, next: Layout): LayoutDelta {
  const before = new Map(prev.nodes.map((n) => [n.key, n]))
  const after = new Map(next.nodes.map((n) => [n.key, n]))

  const entered: LayoutNode[] = []
  const exited: LayoutNode[] = []
  const moved: NodeMove[] = []
  const still: TicketKey[] = []

  for (const n of next.nodes) {
    const was = before.get(n.key)
    if (!was) {
      entered.push(n)
      continue
    }
    if (same(was.x, n.x) && same(was.y, n.y) && same(was.r, n.r)) {
      still.push(n.key)
      continue
    }
    moved.push({
      key: n.key,
      kind: n.kind,
      from: { x: was.x, y: was.y },
      to: { x: n.x, y: n.y },
      fromR: was.r,
      toR: n.r,
    })
  }

  for (const n of prev.nodes) if (!after.has(n.key)) exited.push(n)

  return { entered, exited, moved, still }
}
