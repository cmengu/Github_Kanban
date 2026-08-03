/**
 * The shell. Wires the four modules together and listens for two events.
 *
 * It holds exactly one piece of state — which view you are looking at — and
 * that is a preference, not data. Everything the app knows lives in the graph.
 */

import './render/scene.css'
import { chainOf } from './domain/derive'
import { demo } from './fixtures/demo'
import { layout, type View } from './layout/layout'
import { mount, setFocus } from './render/scene'

const svg = document.querySelector<SVGSVGElement>('#scene')!
const toggle = document.querySelector<HTMLButtonElement>('#view-toggle')!

let view: View = 'map'

/** The whole data path, in one line. Step 3 swaps the fixture; this does not change. */
const draw = (): void => mount(svg, demo, layout(demo, view))

toggle.addEventListener('click', () => {
  view = view === 'map' ? 'board' : 'map'
  toggle.textContent = view === 'map' ? 'Star map ⇄ Board' : 'Board ⇄ Star map'
  draw()
})

svg.addEventListener('pointerover', (e: PointerEvent) => {
  const node = (e.target as Element).closest('g.node')
  setFocus(svg, node ? chainOf(demo, node.getAttribute('data-key') ?? '') : new Set())
})

svg.addEventListener('pointerleave', () => setFocus(svg, new Set()))

draw()
