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
import { layout, type View } from './layout/layout'
import { clearConfig, loadConfig, parseRepo, saveConfig, type Config, type RepoRef } from './live/config'
import { startLoop } from './live/loop'
import type { Poll } from './live/client'
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

/** The whole data path in one line, as in step 1 — the graph is now an argument. */
const draw = (g: DomainGraph): void => {
  current = g
  mount(svg, g, layout(g, view))
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
  draw(g)
  const done = g.tickets.filter((t) => t.state === 'closed').length
  console.log(
    `overviewer: ${g.tickets.length} tickets · ${done} done · canvas ${layout(g, view).height}px · ` +
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
  draw(current)
})

svg.addEventListener('pointerover', (e: PointerEvent) => {
  const node = (e.target as Element).closest('g.node')
  setFocus(svg, node ? chainOf(current, node.getAttribute('data-key') ?? '') : new Set())
})

svg.addEventListener('pointerleave', () => setFocus(svg, new Set()))

boot()
