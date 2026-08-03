/**
 * The fourth pinned seam: config, query, client and loop, driven end to end by
 * a fake `fetch` and a fake clock. No test in this repo may touch the network —
 * a suite whose result depends on GitHub being up is not a test, it is a status
 * page.
 */

import { describe, expect, it } from 'vitest'
import recordScript from '../src/fixtures/payloads/record.sh?raw'
import { clearConfig, loadConfig, parseRepo, repoKey, saveConfig, type Config } from '../src/live/config'
import { batchQuery, readBatch, REPO_FIELDS } from '../src/live/query'
import { authHeaders, pollOnce, type Etags } from '../src/live/client'
import { backoffFor, startLoop } from '../src/live/loop'
import { layout } from '../src/layout/layout'
import { demo } from '../src/fixtures/demo'
import step2 from './fixtures/step2-layout.json'
import { graph, ticket } from './helpers'

// ---------------------------------------------------------------- test doubles

/** A `Storage` that is just a map — config tests never need a browser. */
const fakeStore = (): Storage => {
  const m = new Map<string, string>()
  return {
    get length() {
      return m.size
    },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => void m.delete(k),
    setItem: (k: string, v: string) => void m.set(k, v),
  }
}

interface Call {
  url: string
  init?: RequestInit
}

/**
 * A scripted `fetch`: each rule matches a URL substring and answers with a
 * canned response. Every call is recorded, so a test can assert exactly what
 * went over the wire — and what did not.
 */
const fakeFetch = (
  rule: (url: string, init?: RequestInit) => { status: number; headers?: Record<string, string>; body?: unknown },
): { fetchFn: typeof fetch; calls: Call[] } => {
  const calls: Call[] = []
  const fetchFn = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, ...(init ? { init } : {}) })
    const r = rule(url, init)
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: new Headers(r.headers ?? {}),
      json: async () => r.body,
    } as Response
  }) as typeof fetch
  return { fetchFn, calls }
}

/** A hand-cranked clock: timers fire only when the test says so. */
const fakeClock = (): {
  setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer: (id: ReturnType<typeof setTimeout>) => void
  /** Fire the pending timer and wait for the poll it triggers to settle. */
  tick: () => Promise<void>
  waits: number[]
} => {
  let pending: (() => void) | null = null
  const waits: number[] = []
  return {
    setTimer: (fn, ms) => {
      waits.push(ms)
      pending = fn
      return 0 as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: () => {
      pending = null
    },
    tick: async () => {
      const fn = pending
      pending = null
      fn?.()
      // Let the poll's promise chain settle before the test looks at anything.
      await new Promise((r) => setTimeout(r, 0))
    },
    waits,
  }
}

const cfg = (repos: string[]): Config => ({
  token: 'github_pat_test',
  repos: repos.map((r) => {
    const [owner, name] = r.split('/')
    return { owner: owner as string, name: name as string }
  }),
})

const repoBody = (nameWithOwner: string): Record<string, unknown> => ({
  nameWithOwner,
  issues: { nodes: [] },
  pullRequests: { nodes: [] },
})

/** GraphQL answers for every alias the request asked for, plus the receipt. */
const graphqlOk = (repos: string[]): { status: number; body: unknown } => ({
  status: 200,
  body: {
    data: {
      ...Object.fromEntries(repos.map((r, i) => [`r${i}`, repoBody(r)])),
      rateLimit: { cost: repos.length },
    },
  },
})

// -------------------------------------------------------------------- config

describe('config — the only file that touches storage', () => {
  it('parses owner/name and full GitHub URLs, and rejects the rest', () => {
    expect(parseRepo('cmengu/Github_Kanban')).toEqual({ owner: 'cmengu', name: 'Github_Kanban' })
    expect(parseRepo('https://github.com/cmengu/Github_Kanban')).toEqual({ owner: 'cmengu', name: 'Github_Kanban' })
    expect(parseRepo('https://github.com/cmengu/Github_Kanban/issues/16')).toEqual({ owner: 'cmengu', name: 'Github_Kanban' })
    expect(parseRepo('  o/r.git ')).toEqual({ owner: 'o', name: 'r' })
    expect(parseRepo('not a repo at all !')).toBeNull()
    expect(parseRepo('')).toBeNull()
  })

  it('round-trips a config, and repoKey matches nameWithOwner', () => {
    const store = fakeStore()
    const c = cfg(['cmengu/Github_Kanban'])
    saveConfig(c, store)
    expect(loadConfig(store)).toEqual(c)
    expect(repoKey(c.repos[0]!)).toBe('cmengu/Github_Kanban')
  })

  it('answers null for corrupt or missing JSON instead of throwing', () => {
    const store = fakeStore()
    expect(loadConfig(store)).toBeNull()
    store.setItem('overviewer-config', '{not json')
    expect(loadConfig(store)).toBeNull()
    store.setItem('overviewer-config', JSON.stringify({ token: '', repos: [] }))
    expect(loadConfig(store)).toBeNull()
  })

  it('clearConfig empties the store — sign-out, and what a 401 triggers', () => {
    const store = fakeStore()
    saveConfig(cfg(['o/r']), store)
    clearConfig(store)
    expect(loadConfig(store)).toBeNull()
  })
})

// --------------------------------------------------------------------- query

describe('query — one place the request text exists', () => {
  it('keeps REPO_FIELDS token-for-token identical to record.sh', () => {
    const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()
    expect(squash(recordScript)).toContain(squash(REPO_FIELDS))
  })

  it('gives each repo an alias so N repos cost one request', () => {
    const { query, variables } = batchQuery(cfg(['o/a', 'o/b']).repos)
    expect(query).toContain('r0: repository(owner: $owner0, name: $name0)')
    expect(query).toContain('r1: repository(owner: $owner1, name: $name1)')
    expect(variables).toEqual({ owner0: 'o', name0: 'a', owner1: 'o', name1: 'b' })
  })

  it('survives partial failure: one repo errors, the rest still arrive', () => {
    const repos = cfg(['o/good', 'o/gone']).repos
    const body = {
      data: { r0: repoBody('o/good'), r1: null },
      errors: [{ message: 'Could not resolve to a Repository' }],
    }
    const read = readBatch(body, repos)
    expect(read.repos.map((r) => r.nameWithOwner)).toEqual(['o/good'])
    expect(read.problems).toHaveLength(1)
    expect(read.problems[0]).toContain('o/gone')
    expect(read.problems[0]).toContain('Could not resolve')
  })

  it('names every repo when the whole response is unreadable', () => {
    const read = readBatch({ errors: [{ message: 'bad credentials' }] }, cfg(['o/a']).repos)
    expect(read.repos).toEqual([])
    expect(read.problems).toHaveLength(1)
  })
})

// -------------------------------------------------------------------- client

describe('client — 304 first, fetch second', () => {
  it('304 everywhere → null snapshot, zero GraphQL calls, nothing to draw', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ status: 304 }))
    const etags: Etags = { 'o/a': 'W/"1"', 'o/b': 'W/"2"' }

    const p = await pollOnce(cfg(['o/a', 'o/b']), etags, { fetchFn })

    expect(p.snapshot).toBeNull()
    expect(calls.filter((c) => c.url.includes('graphql'))).toHaveLength(0)
    expect(p.cost).toEqual({ restCalls: 2, points: 0, skipped: 2 })
    expect(p.etags).toEqual(etags)
  })

  it('one repo moves → exactly one GraphQL call, with exactly one alias', async () => {
    const { fetchFn, calls } = fakeFetch((url) => {
      if (url.includes('graphql')) return graphqlOk(['o/b'])
      return url.includes('/repos/o/a/') ? { status: 304 } : { status: 200, headers: { etag: 'W/"new"' } }
    })

    const p = await pollOnce(cfg(['o/a', 'o/b']), { 'o/a': 'W/"1"', 'o/b': 'W/"2"' }, { fetchFn })

    const gql = calls.filter((c) => c.url.includes('graphql'))
    expect(gql).toHaveLength(1)
    const sent = JSON.parse(String(gql[0]!.init?.body)) as { query: string }
    expect(sent.query).toContain('r0:')
    expect(sent.query).not.toContain('r1:')
    expect(p.snapshot?.repos.map((r) => r.nameWithOwner)).toEqual(['o/b'])
    expect(p.etags['o/b']).toBe('W/"new"')
    expect(p.etags['o/a']).toBe('W/"1"')
  })

  it('a repo with no stored ETag counts as changed — first poll fetches everything', async () => {
    const { fetchFn, calls } = fakeFetch((url) =>
      url.includes('graphql') ? graphqlOk(['o/a']) : { status: 200, headers: { etag: 'W/"1"' } },
    )

    const p = await pollOnce(cfg(['o/a']), {}, { fetchFn })

    expect(p.snapshot?.repos).toHaveLength(1)
    expect(p.etags['o/a']).toBe('W/"1"')
    const probe = calls.find((c) => !c.url.includes('graphql'))!
    expect((probe.init?.headers as Record<string, string>)['if-none-match']).toBeUndefined()
  })

  it('a full sweep fetches everything even though every probe would say 304', async () => {
    const { fetchFn, calls } = fakeFetch((url) =>
      url.includes('graphql') ? graphqlOk(['o/a', 'o/b']) : { status: 304 },
    )

    const p = await pollOnce(cfg(['o/a', 'o/b']), { 'o/a': 'W/"1"', 'o/b': 'W/"2"' }, { fetchFn, fullSweep: true })

    // No probes at all: the sweep skips the question and pays for the answer.
    expect(calls.filter((c) => !c.url.includes('graphql'))).toHaveLength(0)
    expect(p.snapshot?.repos).toHaveLength(2)
  })

  it('keeps the token out of URLs and in one header', async () => {
    const { fetchFn, calls } = fakeFetch((url) =>
      url.includes('graphql') ? graphqlOk(['o/a']) : { status: 200, headers: { etag: 'W/"1"' } },
    )
    await pollOnce(cfg(['o/a']), {}, { fetchFn })

    expect(authHeaders('t').authorization).toBe('Bearer t')
    for (const c of calls) {
      expect(c.url).not.toContain('github_pat_test')
      expect((c.init?.headers as Record<string, string>).authorization).toBe('Bearer github_pat_test')
    }
  })

  it('reports GraphQL partial failure without blanking the healthy repos', async () => {
    const { fetchFn } = fakeFetch((url) =>
      url.includes('graphql')
        ? {
            status: 200,
            body: {
              data: { r0: repoBody('o/good'), r1: null, rateLimit: { cost: 2 } },
              errors: [{ message: 'no access' }],
            },
          }
        : { status: 200, headers: { etag: 'W/"1"' } },
    )

    const p = await pollOnce(cfg(['o/good', 'o/gone']), {}, { fetchFn })

    expect(p.snapshot?.repos.map((r) => r.nameWithOwner)).toEqual(['o/good'])
    expect(p.problems.some((x) => x.includes('o/gone'))).toBe(true)
  })
})

// ---------------------------------------------------------------------- loop

describe('loop — the heartbeat, on a hand-cranked clock', () => {
  it('polls, sleeps 45s, and makes the eighth cycle a full sweep', async () => {
    let probes = 0
    let sweeps = 0
    const { fetchFn } = fakeFetch((url) => {
      if (url.includes('graphql')) {
        sweeps++
        return graphqlOk(['o/a'])
      }
      probes++
      return { status: 304 }
    })
    const clock = fakeClock()
    const polls: { snapshot: unknown }[] = []
    const stop = startLoop(cfg(['o/a']), {
      onPoll: (p) => polls.push(p),
      fetchFn,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })
    await new Promise((r) => setTimeout(r, 0))

    for (let i = 0; i < 7; i++) await clock.tick()

    expect(probes).toBe(7) // cycles 1–7 probed and were told 304
    expect(sweeps).toBe(1) // cycle 8 skipped the probe and fetched regardless
    expect(polls).toHaveLength(8)
    expect(polls.slice(0, 7).every((p) => p.snapshot === null)).toBe(true)
    expect(polls[7]!.snapshot).not.toBeNull()
    expect(clock.waits.every((w) => w === 45_000)).toBe(true)
    stop()
  })

  it('a 401 stops the loop and reports the auth failure', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ status: 401 }))
    const clock = fakeClock()
    let authFails = 0

    startLoop(cfg(['o/a']), {
      onPoll: () => {},
      onAuthFail: () => authFails++,
      fetchFn,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })
    await new Promise((r) => setTimeout(r, 0))

    expect(authFails).toBe(1)
    expect(clock.waits).toHaveLength(0) // no next cycle was ever scheduled
    const callsAfter = calls.length
    await clock.tick()
    expect(calls.length).toBe(callsAfter) // and none fires later either
  })

  it('merges partial fetches so an unmoved repo never vanishes from the picture', async () => {
    const { fetchFn, calls } = fakeFetch((url, init) => {
      if (url.includes('graphql')) {
        const sent = JSON.parse(String(init?.body)) as { variables: Record<string, string> }
        const names = Object.keys(sent.variables).filter((k) => k.startsWith('name'))
        return graphqlOk(names.map((k) => `o/${sent.variables[k]}`))
      }
      // o/a answers 304 once it has a stamp — it never moves after cycle 1.
      // o/b answers 200 with a fresh stamp every time — it always moved.
      const stamped = (init?.headers as Record<string, string>)['if-none-match'] != null
      if (url.includes('/repos/o/a/')) return stamped ? { status: 304 } : { status: 200, headers: { etag: 'W/"a"' } }
      return { status: 200, headers: { etag: `W/"b${calls.length}"` } }
    })
    const clock = fakeClock()

    const seen: string[][] = []
    const stop = startLoop(cfg(['o/a', 'o/b']), {
      onPoll: (p) => {
        if (p.snapshot) seen.push(p.snapshot.repos.map((r) => r.nameWithOwner).sort())
      },
      fetchFn,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })
    await new Promise((r) => setTimeout(r, 0))
    await clock.tick()

    // The second poll fetched only o/b, but the emitted picture still has both.
    expect(seen).toEqual([
      ['o/a', 'o/b'],
      ['o/a', 'o/b'],
    ])
    stop()
  })

  it('backs off by what GitHub said, not by guessing', () => {
    expect(backoffFor(200, new Headers())).toBe(0)
    expect(backoffFor(429, new Headers({ 'retry-after': '30' }))).toBe(30_000)
    expect(backoffFor(403, new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000060' }), 1_700_000_000_000)).toBe(60_000)
    expect(backoffFor(403, new Headers())).toBe(60_000)
  })

  it('waits out a rate limit instead of hammering through it', async () => {
    let limitedOnce = false
    const { fetchFn } = fakeFetch(() => {
      if (!limitedOnce) {
        limitedOnce = true
        return { status: 429, headers: { 'retry-after': '120' } }
      }
      return { status: 304 }
    })
    const clock = fakeClock()

    const stop = startLoop(cfg(['o/a']), {
      onPoll: () => {},
      fetchFn,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })
    await new Promise((r) => setTimeout(r, 0))

    expect(clock.waits).toEqual([120_000]) // retry-after beat the 45s default
    await clock.tick()
    expect(clock.waits[1]).toBe(45_000) // and the next healthy cycle went back to it
    stop()
  })
})

// ----------------------------------------------------- layout: the one change

describe('layout — one declared change, and the proof it was the only one', () => {
  it('returns exactly what step 2 returned for a graph with no orphan pulls', () => {
    const g = { ...demo, pulls: [] }
    for (const view of ['map', 'board'] as const) {
      const now = layout(g, view)
      // The two fields step 3 added are stripped; everything else must be
      // byte-identical to the recorded step-2 output.
      const stripped = {
        ...now,
        nodes: now.nodes.map(({ kind, ...rest }) => rest),
        lanes: now.lanes.map(({ pullStripY, ...rest }) => rest),
      }
      expect(JSON.parse(JSON.stringify(stripped))).toEqual(step2[view])
      expect(now.nodes.every((n) => n.kind === 'ticket')).toBe(true)
      expect(now.lanes.every((l) => l.pullStripY === null)).toBe(true)
    }
  })

  it('gives orphan pulls a strip at the bottom of their lane', () => {
    const g = graph([ticket('o/r#1')], [], [
      { key: 'o/r!7', repo: 'o/r', title: 'stray', state: 'open', awaitingReview: false, url: 'u' },
      { key: 'o/r!9', repo: 'o/r', title: 'stray 2', state: 'merged', awaitingReview: false, url: 'u' },
    ])
    const l = layout(g, 'map')
    const lane = l.lanes[0]!
    const pulls = l.nodes.filter((n) => n.kind === 'pull')

    expect(lane.pullStripY).not.toBeNull()
    expect(pulls).toHaveLength(2)
    for (const p of pulls) {
      expect(p.y).toBe(lane.pullStripY)
      expect(p.y).toBeGreaterThan(lane.y)
      expect(p.y).toBeLessThan(lane.y + lane.height)
    }
    // Strip order is key order, left to right.
    expect(pulls.map((p) => p.key)).toEqual(['o/r!7', 'o/r!9'])
    expect(pulls[0]!.x).toBeLessThan(pulls[1]!.x)
  })

  it('lanes a repo that has only orphan pulls, so the work stays visible', () => {
    const g = graph([ticket('o/a#1')], [], [
      { key: 'o/b!1', repo: 'o/b', title: 'stray', state: 'open', awaitingReview: false, url: 'u' },
    ])
    const l = layout(g, 'map')
    expect(l.lanes.map((x) => x.repo)).toContain('o/b')
    expect(l.nodes.find((n) => n.key === 'o/b!1')).toBeDefined()
  })
})
