/**
 * The shell. Wires the modules together and decides, once at boot, which world
 * it is in: a saved config means live polling, no config means the recorded
 * fixture. One branch, at one moment, and never again — after boot, nothing in
 * the app asks which mode it is in.
 *
 * The demo path stays alive on purpose (step 3): it is how the app stays
 * openable with no token, and how a live bug gets reproduced offline.
 */

import './render/scene.css'
import { chainOf } from './domain/derive'
import { demo } from './fixtures/demo'
import { ingestProblems, toDomainGraph } from './ingest/ingest'
import { layout, type Layout, type View } from './layout/layout'
import { clearConfig, loadConfig, parseRepo, saveConfig, type Config, type RepoRef } from './live/config'
import { startLoop } from './live/loop'
import type { Poll } from './live/client'
import { diffLayouts, type LayoutDelta } from './motion/delta'
import { plan, play, snapshotExits } from './motion/choreo'
import { mount, setFocus } from './render/scene'
import type { DomainGraph } from './domain/types'

const svg = document.querySelector<SVGSVGElement>('#scene')!
const toggle = document.querySelector<HTMLButtonElement>('#view-toggle')!
const setup = document.querySelector<HTMLFormElement>('#setup')!
const tokenInput = document.querySelector<HTMLInputElement>('#token')!
const reposInput = document.querySelector<HTMLTextAreaElement>('#repos')!
const setupError = document.querySelector<HTMLParagraphElement>('#setup-error')!
const problemsList = document.querySelector<HTMLUListElement>('#problems')!
const modeNote = document.querySelector<HTMLSpanElement>('#mode-note')!
const signOut = document.querySelector<HTMLButtonElement>('#sign-out')!

let view: View = 'map'
let current: DomainGraph = demo
let stopLoop: (() => void) | null = null
/** The picture on screen right now — the only thing a glide is measured from. */
let shown: Layout | null = null
let cancelGlide: (() => void) | null = null

const reduced = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * The whole data path in one line, as in step 1 — the graph is now an argument.
 * A cut: the new picture simply replaces the old one, with nothing carried
 * across. Boot, sign-out and a refused token all use this, because there is no
 * honest story that connects what was on screen to what comes next.
 */
const draw = (g: DomainGraph): Layout => {
  cancelGlide?.()
  cancelGlide = null
  current = g
  const l = layout(g, view)
  mount(svg, g, l)
  shown = l
  return l
}

/**
 * The same redraw, with the difference shown rather than swapped in.
 *
 * The order matters and is the whole trick: copy the leavers *before* the
 * rebuild, mount the truth, and only then replay how it got there. Any glide
 * already running is cancelled first — it snaps to what is mounted, so the new
 * one always measures from a real picture and never from a half-finished one.
 */
const glideTo = (g: DomainGraph): LayoutDelta | null => {
  const from = shown
  if (!from) {
    draw(g)
    return null
  }

  cancelGlide?.()
  const next = layout(g, view)
  const d = diffLayouts(from, next)
  const ghosts = snapshotExits(svg, d)

  current = g
  mount(svg, g, next)
  shown = next
  // Done sits at the left of the star map and at the right of the board, and
  // the cascade starts there either way.
  const p = plan(d, { reduced: reduced(), doneSide: view === 'map' ? 'left' : 'right' })
  cancelGlide = play(svg, from, next, p, ghosts)
  return d
}

const showProblems = (problems: string[]): void => {
  problemsList.replaceChildren(
    ...problems.map((p) => {
      const li = document.createElement('li')
      li.textContent = p
      return li
    }),
  )
  problemsList.hidden = problems.length === 0
}

/**
 * Nothing changed means nothing moves — literally: a `null` snapshot never
 * reaches the renderer. Otherwise translate, redraw, and write the one-line
 * instrument: the growth curve step 4 needs to settle the Done pile properly.
 */
function onPoll(p: Poll): void {
  if (p.snapshot == null) return
  const g = toDomainGraph(p.snapshot)
  showProblems([...ingestProblems(p.snapshot), ...p.problems])
  const d = glideTo(g)
  const l = shown!
  const done = g.tickets.filter((t) => t.state === 'closed').length
  // The instrument now reports the change as well as the picture: a poll that
  // costs points but moves nothing is a different problem from one that moves
  // half the canvas, and the line has to be able to tell them apart.
  console.log(
    `overviewer: ${g.tickets.length} tickets · ${done} done · canvas ${l.height}px · ` +
      `moved ${d?.moved.length ?? 0} · entered ${d?.entered.length ?? 0} · exited ${d?.exited.length ?? 0} · ` +
      `cost ${p.cost.restCalls} probes, ${p.cost.points} points, ${p.cost.skipped} skipped`,
  )
}

function bootLive(cfg: Config): void {
  setup.hidden = true
  signOut.hidden = false
  modeNote.textContent = `live · ${cfg.repos.length} repo${cfg.repos.length === 1 ? '' : 's'} · polling`
  stopLoop = startLoop(cfg, {
    onPoll,
    // A token GitHub refused must not be retried with — sign out and fall back.
    onAuthFail: () => {
      clearConfig()
      stopLoop = null
      bootDemo()
    },
  })
}

function bootDemo(): void {
  setup.hidden = false
  signOut.hidden = true
  modeNote.textContent = 'demo data · paste a token to go live'
  showProblems([])
  draw(demo)
}

/** The fork: config present → live, absent → the recorded fixture. */
function boot(): void {
  const cfg = loadConfig()
  if (cfg) bootLive(cfg)
  else bootDemo()
}

setup.addEventListener('submit', (e) => {
  e.preventDefault()
  const lines = reposInput.value.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  const repos: RepoRef[] = []
  const bad: string[] = []
  for (const line of lines) {
    const ref = parseRepo(line)
    if (ref) repos.push(ref)
    else bad.push(line)
  }

  // Anything unparseable is marked, not silently dropped.
  if (bad.length > 0 || repos.length === 0 || tokenInput.value.trim().length === 0) {
    setupError.textContent =
      bad.length > 0 ? `not owner/name: ${bad.join(', ')}` : 'a token and at least one repo are needed'
    setupError.hidden = false
    return
  }

  setupError.hidden = true
  saveConfig({ token: tokenInput.value.trim(), repos })
  tokenInput.value = '' // never rendered back after saving
  boot()
})

signOut.addEventListener('click', () => {
  stopLoop?.()
  stopLoop = null
  clearConfig()
  bootDemo()
})

toggle.addEventListener('click', () => {
  view = view === 'map' ? 'board' : 'map'
  toggle.textContent = view === 'map' ? 'Star map ⇄ Board' : 'Board ⇄ Star map'
  // The flip is not a special case: it is the same graph laid out twice, so it
  // is the same diff-and-replay path a poll takes (decision 5). Story 8 comes
  // out of the machinery already built rather than out of code of its own.
  glideTo(current)
})

svg.addEventListener('pointerover', (e: PointerEvent) => {
  const node = (e.target as Element).closest('g.node')
  setFocus(svg, node ? chainOf(current, node.getAttribute('data-key') ?? '') : new Set())
})

svg.addEventListener('pointerleave', () => setFocus(svg, new Set()))

boot()
