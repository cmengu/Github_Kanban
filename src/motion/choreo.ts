/**
 * When each thing moves, and the one loop that moves it.
 *
 * The file is deliberately two halves. `plan` is pure — a delta in, a schedule
 * out — so "the cascade reads outward from Done" and "the whole thing is over
 * inside a second" are assertions in a unit test rather than opinions about a
 * video. `play` is the only requestAnimationFrame in the app, and it does no
 * deciding at all: it reads the schedule and interpolates.
 *
 * The renderer is not edited, and is not asked to reconcile anything. `mount`
 * has already drawn the final frame; this is FLIP — the elements are shoved
 * back to where they were and released. So the DOM is always truth and motion
 * is replayed memory, which is why cancelling a glide can never leave a stale
 * picture: there is nothing to roll back, only an offset to drop.
 */

import { edgePath, type Layout, type Point } from '../layout/layout'
import type { LayoutDelta } from './delta'
import type { TicketKey } from '../domain/types'

export type Act = 'exit' | 'move' | 'enter'

export interface Cue {
  key: TicketKey
  act: Act
  /** Milliseconds from the start of the glide. */
  at: number
  dur: number
}

export interface MotionPlan {
  cues: Cue[]
  total: number
}

const EXIT_MS = 180
const MOVE_MS = 520
const ENTER_MS = 260
/** The gap between one star setting off and the next. */
const STAGGER_MS = 40
/**
 * However many stars move, the last one sets off within this long. A fixed
 * stagger is fine for six stars and absurd for sixty — this bounds the wait
 * without giving up the cascade.
 */
const SPREAD_MS = 420

export interface PlanOpts {
  /** `prefers-reduced-motion`. Everything still happens, all of it at once. */
  reduced?: boolean
  /**
   * Which side of the canvas finished work sits on: `'left'` on the star map,
   * `'right'` on the board. It is the only view-dependent thing in this file,
   * and it is here because the cascade has to start at the cause. When a
   * blocker closes it drops into the Done pile and its dependents shuffle in
   * behind it, so the movement propagates *outward from Done* — which is a
   * different direction on each of the two projections.
   */
  doneSide?: 'left' | 'right'
}

/**
 * Turns a difference into a schedule: what leaves, goes; what moves, moves;
 * what arrives, arrives once the moving has stopped, so a star never lands on
 * a spot another star has not vacated yet.
 */
export function plan(d: LayoutDelta, opts: PlanOpts = {}): MotionPlan {
  const exitMs = opts.reduced ? 0 : EXIT_MS
  const moveMs = opts.reduced ? 0 : MOVE_MS
  const enterMs = opts.reduced ? 0 : ENTER_MS

  const cues: Cue[] = []
  for (const n of d.exited) cues.push({ key: n.key, act: 'exit', at: 0, dur: exitMs })

  const near = opts.doneSide === 'right' ? -1 : 1
  const movers = [...d.moved].sort(
    (a, b) => near * (a.to.x - b.to.x) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  )
  const step = opts.reduced
    ? 0
    : Math.min(STAGGER_MS, movers.length > 1 ? SPREAD_MS / (movers.length - 1) : STAGGER_MS)
  movers.forEach((m, i) => {
    cues.push({ key: m.key, act: 'move', at: exitMs + Math.round(i * step), dur: moveMs })
  })

  const movesEnd = cues
    .filter((c) => c.act === 'move')
    .reduce((end, c) => Math.max(end, c.at + c.dur), exitMs)
  // Arrivals wait for the shuffling to finish. A star fading in on top of one
  // still sliding out of that spot reads as two things in one place, which is
  // the one thing a picture of a graph must never say.
  for (const n of d.entered) cues.push({ key: n.key, act: 'enter', at: movesEnd, dur: enterMs })

  return { cues, total: cues.reduce((end, c) => Math.max(end, c.at + c.dur), 0) }
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)
/** Slow at both ends: stars leave and arrive gently, and cover ground between. */
const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/**
 * The scene's stars and edges, looked up once by the names the renderer already
 * stamps on them (`data-key`, `data-blocked`/`data-by`). Once, because a glide
 * asks for them sixty times a second — and by attribute, because a ticket key
 * holds `/`, `#` and `!`, none of which survive being pasted into a selector.
 */
const indexNodes = (svg: SVGSVGElement): Map<TicketKey, SVGGElement> => {
  const out = new Map<TicketKey, SVGGElement>()
  for (const el of svg.querySelectorAll<SVGGElement>('g.node')) {
    const key = el.getAttribute('data-key')
    if (key !== null) out.set(key, el)
  }
  return out
}

const indexEdges = (svg: SVGSVGElement): Map<string, SVGGElement> => {
  const out = new Map<string, SVGGElement>()
  for (const el of svg.querySelectorAll<SVGGElement>('g.edge')) {
    out.set(`${el.getAttribute('data-blocked')} ${el.getAttribute('data-by')}`, el)
  }
  return out
}

/**
 * Copies the elements that are about to be deleted, so they can be seen
 * leaving. Must be called *before* `mount` rebuilds the scene — after it, the
 * originals are already gone.
 */
export function snapshotExits(svg: SVGSVGElement, d: LayoutDelta): SVGGElement[] {
  const live = indexNodes(svg)
  const out: SVGGElement[] = []
  for (const n of d.exited) {
    const el = live.get(n.key)
    if (!el) continue
    const ghost = el.cloneNode(true) as SVGGElement
    ghost.classList.add('is-ghost')
    // A ghost is a picture of something that no longer exists; it must not be
    // hoverable, focusable, or clickable through to GitHub. It keeps its key
    // under a different name, so its cue is matched by name and not by index —
    // one element failing to clone must not shift everybody else's timing.
    ghost.removeAttribute('data-key')
    ghost.setAttribute('data-ghost-key', n.key)
    ghost.setAttribute('aria-hidden', 'true')
    ghost.style.pointerEvents = 'none'
    // scene.css fades .node opacity for the hover highlight. A ghost's opacity
    // is written every frame instead, and the two clocks would fight.
    ghost.style.transition = 'none'
    out.push(ghost)
  }
  return out
}

export interface PlayOpts {
  raf?: (fn: (t: number) => void) => number
  caf?: (id: number) => void
}

/**
 * Runs the schedule against a scene that is *already showing `next`*, and
 * returns the function that stops it.
 *
 * Cancelling is not an abort: it snaps to the truth already mounted, which is
 * the same thing finishing does. That is the whole reason the renderer stayed
 * untouched — a poll that lands mid-glide interrupts a memory, never the data.
 */
export function play(
  svg: SVGSVGElement,
  prev: Layout,
  next: Layout,
  p: MotionPlan,
  ghosts: SVGGElement[],
  opts: PlayOpts = {},
): () => void {
  const raf = opts.raf ?? ((fn) => requestAnimationFrame(fn))
  const caf = opts.caf ?? ((id) => cancelAnimationFrame(id))

  const nodes = indexNodes(svg)
  const edges = indexEdges(svg)
  const prevR = new Map(prev.nodes.map((n) => [n.key, n.r]))
  const nextR = new Map(next.nodes.map((n) => [n.key, n.r]))
  const moves = p.cues.filter((c) => c.act === 'move')
  const enters = p.cues.filter((c) => c.act === 'enter')
  const exits = new Map(p.cues.filter((c) => c.act === 'exit').map((c) => [c.key, c]))
  // Looked up by key rather than searched for: `pointAt` is called once per
  // star and twice per edge, sixty times a second. The renderer's own header
  // records what happens when per-frame work is done the lazy way.
  const moveByKey = new Map(moves.map((c) => [c.key, c]))

  // Entering stars are driven frame by frame; scene.css's opacity transition
  // must not also have an opinion about them.
  for (const cue of enters) nodes.get(cue.key)?.style.setProperty('transition', 'none')

  const ghostLayer = document.createElementNS(svg.namespaceURI, 'g')
  ghostLayer.setAttribute('class', 'ghosts')
  if (ghosts.length > 0) {
    ghostLayer.append(...ghosts)
    svg.append(ghostLayer)
  }

  /** Where a star is at time `t` — the single source both stars and edges read. */
  const pointAt = (key: TicketKey, t: number): Point => {
    const cue = moveByKey.get(key)
    const to = next.pos[key]
    const from = prev.pos[key]
    if (!cue || !to || !from) return to ?? from ?? { x: 0, y: 0 }
    const e = ease(clamp01(cue.dur === 0 ? 1 : (t - cue.at) / cue.dur))
    return { x: lerp(from.x, to.x, e), y: lerp(from.y, to.y, e) }
  }

  const frame = (t: number): void => {
    for (const cue of moves) {
      const el = nodes.get(cue.key)
      if (!el) continue
      const at = pointAt(cue.key, t)
      const to = next.pos[cue.key]!
      // The element is mounted at its final place; the offset is what is left
      // of the journey, so the transform runs down to zero and disappears.
      el.style.transform = `translate(${at.x - to.x}px, ${at.y - to.y}px)`

      const e = ease(clamp01(cue.dur === 0 ? 1 : (t - cue.at) / cue.dur))
      const r0 = prevR.get(cue.key)
      const r1 = nextR.get(cue.key)
      if (r0 !== undefined && r1 !== undefined && Math.abs(r0 - r1) > 0.02 * r1) {
        const k = lerp(r0 / r1, 1, e)
        for (const c of el.querySelectorAll<SVGElement>('.orb, .glow')) {
          c.style.transform = `scale(${k})`
        }
      }
    }

    for (const cue of enters) {
      const el = nodes.get(cue.key)
      if (!el) continue
      el.style.opacity = String(ease(clamp01(cue.dur === 0 ? 1 : (t - cue.at) / cue.dur)))
    }

    for (const ghost of ghosts) {
      const cue = exits.get(ghost.getAttribute('data-ghost-key') ?? '')
      const e = ease(clamp01(!cue || cue.dur === 0 ? 1 : (t - cue.at) / cue.dur))
      ghost.style.opacity = String(1 - e)
    }

    // Edges ride the stars: recomputed from wherever their endpoints currently
    // are, with the same arithmetic the layout used — not a separate copy of it.
    for (const path of next.paths) {
      const group = edges.get(`${path.blocked} ${path.by}`)
      if (!group) continue
      const curve = edgePath(pointAt(path.by, t), pointAt(path.blocked, t))
      group.querySelector('.edge-line')?.setAttribute('d', curve.d)
      const dot = group.querySelector('.edge-dot')
      dot?.setAttribute('cx', String(curve.dot.x))
      dot?.setAttribute('cy', String(curve.dot.y))
    }
  }

  /** Drop every trace of the glide. The scene underneath is already correct. */
  const finish = (): void => {
    for (const cue of moves) {
      const el = nodes.get(cue.key)
      if (!el) continue
      el.style.removeProperty('transform')
      for (const c of el.querySelectorAll<SVGElement>('.orb, .glow')) c.style.removeProperty('transform')
    }
    for (const cue of enters) {
      const el = nodes.get(cue.key)
      el?.style.removeProperty('opacity')
      el?.style.removeProperty('transition')
    }
    ghostLayer.remove()

    for (const path of next.paths) {
      const group = edges.get(`${path.blocked} ${path.by}`)
      group?.querySelector('.edge-line')?.setAttribute('d', path.d)
      const dot = group?.querySelector('.edge-dot')
      dot?.setAttribute('cx', String(path.dot.x))
      dot?.setAttribute('cy', String(path.dot.y))
    }
  }

  // Nothing to replay — reduced motion, or a change that moved nothing.
  if (p.total <= 0) {
    finish()
    return () => {}
  }

  let done = false
  let id = 0
  let start: number | null = null

  // The first frame is drawn now, not one animation frame from now: the scene
  // is already mounted at its destination, and a single frame of everybody
  // standing at the end before jumping back to the start is exactly the flicker
  // FLIP exists to avoid.
  frame(0)

  const tick = (now: number): void => {
    if (done) return
    if (start === null) start = now
    const t = now - start
    frame(Math.min(t, p.total))
    if (t >= p.total) {
      done = true
      finish()
      return
    }
    id = raf(tick)
  }

  id = raf(tick)

  return () => {
    if (done) return
    done = true
    caf(id)
    finish()
  }
}
