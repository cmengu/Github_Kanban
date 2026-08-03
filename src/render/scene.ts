/**
 * The only file that touches the screen.
 *
 * It decides nothing: it imports the shapes and the layout, and pointedly not
 * `derive.ts`. If this file ever needs to work something out, that is the
 * signal the answer belongs in `derive.ts` instead.
 *
 * The two exported functions are deliberately separate jobs. `mount` rebuilds
 * when the *data* changes; `setFocus` only toggles classes when the *pointer*
 * moves. The prototype rebuilt on hover and went sluggish — that lesson is
 * encoded as this split.
 */

import type { Layout, LayoutNode } from '../layout/layout'
import type { DomainGraph, Ticket, TicketKey } from '../domain/types'

const SVG_NS = 'http://www.w3.org/2000/svg'

const el = <K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] => {
  const node = document.createElementNS(SVG_NS, name)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
  return node
}

/** Gradients and filters, defined once per mount. */
function defs(): SVGDefsElement {
  const d = el('defs')

  const orb = el('radialGradient', { id: 'orb', cx: '38%', cy: '32%', r: '75%' })
  orb.append(
    el('stop', { offset: '0%', 'stop-color': '#c8ece8' }),
    el('stop', { offset: '58%', 'stop-color': '#4f9b95' }),
    el('stop', { offset: '100%', 'stop-color': '#2c5f5b' }),
  )

  const dwarf = el('radialGradient', { id: 'dwarf', cx: '38%', cy: '32%', r: '75%' })
  dwarf.append(
    el('stop', { offset: '0%', 'stop-color': '#e8ecf6' }),
    el('stop', { offset: '100%', 'stop-color': '#7d84a0' }),
  )

  d.append(orb, dwarf)
  return d
}

const classesFor = (n: LayoutNode): string => {
  const out = ['node']
  if (n.done) out.push('is-done')
  if (n.blocked) out.push('is-blocked')
  if (n.frontier) out.push('is-frontier')
  if (n.humanGated) out.push('is-gated')
  return out.join(' ')
}

/**
 * Draws a whole `Layout` as SVG, replacing whatever was there.
 * Reads numbers and strings only — every decision was already made upstream.
 */
export function mount(svg: SVGSVGElement, g: DomainGraph, l: Layout): void {
  const titles = new Map<TicketKey, Ticket>(g.tickets.map((t) => [t.key, t]))

  svg.replaceChildren()
  svg.setAttribute('viewBox', `0 0 ${l.width} ${l.height}`)
  svg.append(defs())

  // ---- lane borders: tickets never cross them (#7) ----
  const laneLayer = el('g', { class: 'lanes' })
  for (const lane of l.lanes) {
    laneLayer.append(
      el('line', { class: 'lane-line', x1: 0, y1: lane.y, x2: l.width, y2: lane.y }),
    )
    const label = el('text', { class: 'lane-label', x: 10, y: lane.y + 16 })
    label.textContent = lane.repo
    laneLayer.append(label)
  }

  // ---- edges: no arrowheads, a dot at the blocker end (#2) ----
  const edgeLayer = el('g', { class: 'edges' })
  for (const p of l.paths) {
    const cls = ['edge', p.blockerOpen ? 'is-waiting' : 'is-settled']
    if (p.crossLane) cls.push('is-cross')
    edgeLayer.append(
      el('path', { class: cls.join(' '), d: p.d, 'data-blocked': p.blocked, 'data-by': p.by }),
      el('circle', { class: 'edge-dot', cx: p.dot.x, cy: p.dot.y, r: 2.4 }),
    )
  }

  // ---- stars ----
  const nodeLayer = el('g', { class: 'nodes' })
  for (const n of l.nodes) {
    const t = titles.get(n.key)
    const group = el('g', { class: classesFor(n), 'data-key': n.key, transform: `translate(${n.x} ${n.y})` })

    // Finished work collapses to a white dwarf; everything drawn around the
    // orb follows that radius so a small star never wears a large halo.
    const r = n.done ? Math.max(4, n.r * 0.5) : n.r

    if (n.frontier) group.append(el('circle', { class: 'halo', cx: 0, cy: 0, r: r + 7 }))
    group.append(el('circle', { class: 'glow', cx: 0, cy: 0, r: r + 6 }))
    group.append(el('circle', { class: 'orb', cx: 0, cy: 0, r }))

    // One ring in orbit per open PR (#6).
    for (let i = 0; i < n.rings; i++) {
      group.append(
        el('ellipse', {
          class: 'ring',
          cx: 0,
          cy: 0,
          rx: r + 6 + i * 4,
          ry: (r + 6 + i * 4) * 0.4,
          transform: 'rotate(-22)',
        }),
      )
    }

    const label = el('text', { class: 'label', x: 0, y: r + 17, 'text-anchor': 'middle' })
    label.textContent = n.key.slice(n.key.lastIndexOf('#'))
    group.append(label)

    // A generous invisible target, so small stars are still easy to hit.
    group.append(el('circle', { class: 'hit', cx: 0, cy: 0, r: Math.max(24, n.r + 12) }))

    const tip = el('title')
    tip.textContent = t ? `${n.key} — ${t.title}\ngates ${n.gated} open · wave ${n.wave}` : n.key
    group.append(tip)

    nodeLayer.append(group)
  }

  svg.append(laneLayer, edgeLayer, nodeLayer)
}

/**
 * The hover highlight: lights a ticket's whole chain and dims the rest.
 * Toggles classes only — nothing is rebuilt, nothing is measured.
 */
export function setFocus(svg: SVGSVGElement, chain: Set<TicketKey>): void {
  const quiet = chain.size === 0
  svg.classList.toggle('has-focus', !quiet)

  for (const node of svg.querySelectorAll<SVGGElement>('g.node')) {
    const key = node.getAttribute('data-key') ?? ''
    node.classList.toggle('is-lit', !quiet && chain.has(key))
  }

  for (const edge of svg.querySelectorAll<SVGPathElement>('path.edge')) {
    const lit =
      !quiet &&
      chain.has(edge.getAttribute('data-blocked') ?? '') &&
      chain.has(edge.getAttribute('data-by') ?? '')
    edge.classList.toggle('is-lit', lit)
  }
}
