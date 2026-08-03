/**
 * @vitest-environment jsdom
 *
 * One smoke test over the fixture dataset, as the spec's testing decisions ask
 * for. It asserts the fused view's invariants — every node in its derived
 * bucket and wave, nobody outside their lane — and the one render behaviour
 * worth pinning: hover must not rebuild the scene.
 *
 * Everything else about the renderer stays untested presentation, by decision.
 */

import { describe, expect, it } from 'vitest'
import { bucketOf, chainOf, frontier, waves } from '../src/domain/derive'
import { demo } from '../src/fixtures/demo'
import { layout } from '../src/layout/layout'
import { mount, setFocus } from '../src/render/scene'
import { repoOf } from '../src/domain/types'

const scene = (): SVGSVGElement =>
  document.createElementNS('http://www.w3.org/2000/svg', 'svg')

describe('the fixture renders a coherent fused view', () => {
  it('places every fixture ticket in its derived bucket, wave and lane', () => {
    const l = layout(demo, 'map')
    const w = waves(demo)
    const byKey = new Map(demo.tickets.map((t) => [t.key, t]))
    const laneOf = new Map(l.lanes.map((lane) => [lane.repo, lane]))

    expect(l.nodes).toHaveLength(demo.tickets.length)
    for (const n of l.nodes) {
      expect(n.bucket).toBe(bucketOf(byKey.get(n.key)!))
      expect(n.wave).toBe(w.get(n.key))
      const lane = laneOf.get(repoOf(n.key))!
      expect(n.y).toBeGreaterThanOrEqual(lane.y)
      expect(n.y).toBeLessThanOrEqual(lane.y + lane.height)
    }
  })

  it('has a frontier to start from and finished work sitting at wave 0', () => {
    const w = waves(demo)
    expect(frontier(demo).length).toBeGreaterThan(0)
    for (const t of demo.tickets) {
      if (t.state === 'closed') expect(w.get(t.key)).toBe(0)
    }
  })
})

describe('mount / setFocus — data changes rebuild, pointer moves do not', () => {
  it('draws one group per ticket and one path per surviving edge', () => {
    const svg = scene()
    const l = layout(demo, 'map')
    mount(svg, demo, l)

    expect(svg.querySelectorAll('g.node')).toHaveLength(demo.tickets.length)
    expect(svg.querySelectorAll('g.edge')).toHaveLength(l.paths.length)
    expect(svg.querySelectorAll('text.col-label')).toHaveLength(l.columns.length)
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${l.width} ${l.height}`)
  })

  it('links every star through to its issue on GitHub', () => {
    const svg = scene()
    mount(svg, demo, layout(demo, 'map'))

    const byKey = new Map(demo.tickets.map((t) => [t.key, t]))
    const links = svg.querySelectorAll('g.node a')
    expect(links).toHaveLength(demo.tickets.length)
    for (const a of links) {
      const key = a.closest('g.node')!.getAttribute('data-key')!
      expect(a.getAttribute('href')).toBe(byKey.get(key)!.url)
    }
  })

  it('lights a chain by toggling classes, without rebuilding anything', () => {
    const svg = scene()
    mount(svg, demo, layout(demo, 'map'))

    const before = svg.querySelectorAll('*').length
    const key = 'cmengu/Github_Kanban#14'
    setFocus(svg, chainOf(demo, key))

    expect(svg.querySelectorAll('*').length).toBe(before)
    expect(svg.classList.contains('has-focus')).toBe(true)
    expect(svg.querySelector(`g.node[data-key="${key}"]`)!.classList.contains('is-lit')).toBe(true)

    const lit = svg.querySelectorAll('g.node.is-lit').length
    expect(lit).toBe(chainOf(demo, key).size)
  })

  it('clears the focus when the pointer leaves everything', () => {
    const svg = scene()
    mount(svg, demo, layout(demo, 'map'))

    setFocus(svg, chainOf(demo, 'cmengu/Github_Kanban#14'))
    setFocus(svg, new Set())

    expect(svg.classList.contains('has-focus')).toBe(false)
    expect(svg.querySelectorAll('g.node.is-lit')).toHaveLength(0)
  })

  it('redraws cleanly when the view flips, leaving no stale elements', () => {
    const svg = scene()
    mount(svg, demo, layout(demo, 'map'))
    mount(svg, demo, layout(demo, 'board'))

    expect(svg.querySelectorAll('g.node')).toHaveLength(demo.tickets.length)
    expect(svg.querySelectorAll('defs')).toHaveLength(1)
  })
})
