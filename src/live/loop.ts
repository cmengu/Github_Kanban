/**
 * The 45-second heartbeat — the only file in the app that holds a timer.
 *
 * It owns the state between polls: the ETag table, the cycle count that makes
 * every eighth poll a full sweep (decision 2), and the last payload seen per
 * repo. That last one matters because a partial fetch returns only the repos
 * that moved — without the merge, a poll that fetched one repo would blank the
 * other nine lanes.
 *
 * Everything it depends on — the clock, `fetch` — is injectable, so the test
 * suite can run four hours of polling in a millisecond.
 */

import type { Config } from './config'
import type { Poll } from './client'
import type { RepoPayload, Snapshot } from '../ingest/payloads'
import { pollOnce } from './client'

export interface LoopOpts {
  /** What to do with each poll's result. `snapshot: null` means nothing moved. */
  onPoll: (p: Poll) => void
  /** GitHub refused the token. The caller signs out; the loop has already stopped. */
  onAuthFail?: () => void
  /** How often, in milliseconds. */
  everyMs?: number
  /** Every Nth cycle fetches everything, however the probes answered. */
  sweepEvery?: number
  /** Injectable for tests — no test in this repo may touch the network. */
  fetchFn?: typeof fetch
  /** Injectable clock, same shape as `setTimeout`/`clearTimeout`. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (id: ReturnType<typeof setTimeout>) => void
}

/**
 * How long to wait after GitHub said "stop asking" — honouring `retry-after`
 * and `x-ratelimit-reset` instead of guessing. A pure function of the response
 * (plus an injectable "now" for the reset arithmetic), so every rate-limit case
 * is a unit test with no clock and no network.
 */
export function backoffFor(status: number, headers: Headers, nowMs: number = Date.now()): number {
  if (status !== 403 && status !== 429) return 0

  const retryAfter = Number(headers.get('retry-after'))
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000

  const reset = Number(headers.get('x-ratelimit-reset'))
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - nowMs)

  // Rate limited with no usable header: one minute, GitHub's documented floor.
  return 60_000
}

/**
 * Runs the heartbeat and hands each result to the caller. Returns the function
 * that stops it — one way to end the loop, no way to forget which one you
 * meant.
 *
 * Polls are chained, not intervalled: the next timer is set only after the
 * current poll settles, so a slow response can never stack work behind it.
 */
export function startLoop(cfg: Config, opts: LoopOpts): () => void {
  const everyMs = opts.everyMs ?? 45_000
  const sweepEvery = opts.sweepEvery ?? 8
  const setTimer = opts.setTimer ?? setTimeout
  const clearTimer = opts.clearTimer ?? clearTimeout

  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let etags: Poll['etags'] = {}
  let cycle = 0
  const lastByRepo = new Map<string, RepoPayload>()

  /**
   * A partial fetch knows only the repos that moved. Fold it into what earlier
   * polls saw, so the emitted snapshot is always the whole picture.
   */
  const merged = (snap: Snapshot): Snapshot => {
    for (const repo of snap.repos) {
      if (typeof repo?.nameWithOwner === 'string') lastByRepo.set(repo.nameWithOwner, repo)
    }
    return { repos: [...lastByRepo.values()] }
  }

  const tick = async (): Promise<void> => {
    cycle++
    const sweep = cycle % sweepEvery === 0
    const p = await pollOnce(cfg, etags, {
      fullSweep: sweep,
      ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
    })
    if (stopped) return
    etags = p.etags

    opts.onPoll({ ...p, snapshot: p.snapshot ? merged(p.snapshot) : null })

    if (p.authFailed) {
      stopped = true
      opts.onAuthFail?.()
      return
    }

    const wait = p.limited ? Math.max(everyMs, backoffFor(p.limited.status, p.limited.headers)) : everyMs
    timer = setTimer(() => void tick(), wait)
  }

  void tick()

  return () => {
    stopped = true
    if (timer != null) clearTimer(timer)
  }
}
