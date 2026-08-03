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
import type { DomainGraph, PullNode, Ticket, TicketKey } from '../domain/types'

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
  if (n.kind === 'pull') out.push('is-pull')
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
  const orphans = new Map<string, PullNode>(g.pulls.map((p) => [p.key, p]))

  svg.replaceChildren()
  svg.setAttribute('viewBox', `0 0 ${l.width} ${l.height}`)
  const sceneDefs = defs()
  svg.append(sceneDefs)

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

  // ---- edges: no arrowheads, a gradient fading bright toward the blocker,
  // and a dot marking that end (#2) ----
  const edgeLayer = el('g', { class: 'edges' })
  l.paths.forEach((p, i) => {
    const from = l.pos[p.by]
    const to = l.pos[p.blocked]
    if (!from || !to) return

    const id = `edge-grad-${i}`
    const tint = p.blockerOpen ? '#ac9fe8' : '#8fc8c3'
    const grad = el('linearGradient', {
      id,
      gradientUnits: 'userSpaceOnUse',
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
    })
    grad.append(
      el('stop', { offset: '0%', 'stop-color': tint, 'stop-opacity': 0.8 }),
      el('stop', { offset: '100%', 'stop-color': tint, 'stop-opacity': 0.12 }),
    )
    sceneDefs.append(grad)

    const cls = ['edge', p.blockerOpen ? 'is-waiting' : 'is-settled']
    if (p.crossLane) cls.push('is-cross')
    const group = el('g', { class: cls.join(' '), 'data-blocked': p.blocked, 'data-by': p.by })
    group.append(
      el('path', { class: 'edge-line', d: p.d, stroke: `url(#${id})` }),
      el('circle', { class: 'edge-dot', cx: p.dot.x, cy: p.dot.y, r: 2.4, fill: tint }),
    )
    edgeLayer.append(group)
  })

  // ---- column headings: a column should say what it means (#3) ----
  const colLayer = el('g', { class: 'columns' })
  for (const c of l.columns) {
    const head = el('text', { class: 'col-label', x: c.x, y: 22, 'text-anchor': 'middle' })
    head.textContent = c.label
    colLayer.append(head)
  }
  svg.append(colLayer)

  // ---- stars ----
  const nodeLayer = el('g', { class: 'nodes' })
  for (const n of l.nodes) {
    // An orphan PR is a different kind of thing, so it gets a different shape
    // (step 3, decision 4): a hollow ring, not an orb — it has no wave and no
    // bucket, and a filled orb would claim a position nothing computed.
    if (n.kind === 'pull') {
      const p = orphans.get(n.key)
      const group = el('g', { class: classesFor(n), 'data-key': n.key, transform: `translate(${n.x} ${n.y})` })
      const link = el('a', { href: p?.url ?? '#', target: '_blank', rel: 'noopener' })

      link.append(el('circle', { class: 'pull-ring', cx: 0, cy: 0, r: n.r }))
      const bang = n.key.lastIndexOf('!')
      const label = el('text', { class: 'label', x: 0, y: n.r + 14, 'text-anchor': 'middle' })
      label.textContent = bang === -1 ? n.key : n.key.slice(bang)
      link.append(label)
      link.append(el('circle', { class: 'hit', cx: 0, cy: 0, r: 16 }))

      const tip = el('title')
      tip.textContent = p ? `${n.key} — ${p.title}\n${p.state}, closes no loaded issue` : n.key
      link.append(tip)
      group.append(link)
      nodeLayer.append(group)
      continue
    }

    const t = titles.get(n.key)
    const group = el('g', { class: classesFor(n), 'data-key': n.key, transform: `translate(${n.x} ${n.y})` })

    // Through to the issue on GitHub — the Overviewer stays a lens, never a
    // silo (story 19). Everything visual hangs off this link.
    const link = el('a', { href: t?.url ?? '#', target: '_blank', rel: 'noopener' })

    // Finished work collapses to a white dwarf; everything drawn around the
    // orb follows that radius so a small star never wears a large halo.
    const r = n.done ? Math.max(4, n.r * 0.5) : n.r

    if (n.frontier) link.append(el('circle', { class: 'halo', cx: 0, cy: 0, r: r + 7 }))
    link.append(el('circle', { class: 'glow', cx: 0, cy: 0, r: r + 6 }))
    link.append(el('circle', { class: 'orb', cx: 0, cy: 0, r }))

    // One ring in orbit per linked PR, stacking outward (#6).
    for (let i = 0; i < n.rings; i++) {
      link.append(
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

    const hash = n.key.lastIndexOf('#')
    const label = el('text', { class: 'label', x: 0, y: r + 17, 'text-anchor': 'middle' })
    label.textContent = hash === -1 ? n.key : n.key.slice(hash)
    link.append(label)

    // A generous invisible target so small stars stay easy to hit, capped so
    // that vertically adjacent rows never steal each other's clicks.
    link.append(el('circle', { class: 'hit', cx: 0, cy: 0, r: Math.min(34, Math.max(20, r + 10)) }))

    const tip = el('title')
    tip.textContent = t ? `${n.key} — ${t.title}\ngates ${n.gated} open · wave ${n.wave}` : n.key
    link.append(tip)
    group.append(link)

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

  for (const edge of svg.querySelectorAll<SVGGElement>('g.edge')) {
    const lit =
      !quiet &&
      chain.has(edge.getAttribute('data-blocked') ?? '') &&
      chain.has(edge.getAttribute('data-by') ?? '')
    edge.classList.toggle('is-lit', lit)
  }
}
