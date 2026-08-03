import { describe, expect, it } from 'vitest'
import { bucketOf, chainOf, frontier, gatedCount, indexOf, waveOf, waves } from '../src/domain/derive'
import { graph, pr, ticket } from './helpers'

describe('bucketOf — the #4 table', () => {
  it('closed → done', () => {
    expect(bucketOf(ticket('o/r#1', { state: 'closed' }))).toBe('done')
  })

  it('open with an open PR → in-review', () => {
    expect(bucketOf(ticket('o/r#1', { prs: [pr({ state: 'open' })] }))).toBe('in-review')
  })

  it('open with an assignee → in-progress', () => {
    expect(bucketOf(ticket('o/r#1', { assignee: 'cmengu' }))).toBe('in-progress')
  })

  it('open, unclaimed, no PR → tickets', () => {
    expect(bucketOf(ticket('o/r#1'))).toBe('tickets')
  })

  it('a merged or closed PR does not put an open ticket in review', () => {
    expect(bucketOf(ticket('o/r#1', { prs: [pr({ state: 'merged' })] }))).toBe('tickets')
    expect(bucketOf(ticket('o/r#1', { prs: [pr({ state: 'closed' })] }))).toBe('tickets')
  })
})

describe('bucketOf — precedence', () => {
  it('closed beats everything', () => {
    const t = ticket('o/r#1', { state: 'closed', assignee: 'cmengu', prs: [pr({ state: 'open' })] })
    expect(bucketOf(t)).toBe('done')
  })

  it('an open PR beats an assignee', () => {
    const t = ticket('o/r#1', { assignee: 'cmengu', prs: [pr({ state: 'open' })] })
    expect(bucketOf(t)).toBe('in-review')
  })
})

describe('indexOf', () => {
  it('indexes tickets by key and edges in both directions', () => {
    const g = graph(
      [ticket('o/r#1'), ticket('o/r#2'), ticket('o/r#3')],
      [
        { blocked: 'o/r#2', by: 'o/r#1' },
        { blocked: 'o/r#3', by: 'o/r#2' },
      ],
    )
    const ix = indexOf(g)

    expect(ix.byKey.get('o/r#2')?.title).toBe('ticket o/r#2')
    expect(ix.blockers.get('o/r#2')).toEqual(['o/r#1'])
    expect(ix.dependents.get('o/r#1')).toEqual(['o/r#2'])
    expect(ix.blockers.get('o/r#1') ?? []).toEqual([])
  })

  it('drops dangling edges once, so nothing downstream has to care', () => {
    const g = graph(
      [ticket('o/r#1')],
      [
        { blocked: 'o/r#1', by: 'other/repo#99' },
        { blocked: 'other/repo#99', by: 'o/r#1' },
      ],
    )
    const ix = indexOf(g)

    expect(ix.blockers.get('o/r#1') ?? []).toEqual([])
    expect(ix.dependents.get('o/r#1') ?? []).toEqual([])
    expect(ix.byKey.has('other/repo#99')).toBe(false)
  })
})

describe('waves', () => {
  it('done is wave 0 no matter what it depends on', () => {
    const g = graph(
      [ticket('o/r#1'), ticket('o/r#2', { state: 'closed' })],
      [{ blocked: 'o/r#2', by: 'o/r#1' }],
    )
    expect(waves(g).get('o/r#2')).toBe(0)
  })

  it('an open ticket with no open blockers is wave 1 — ready now', () => {
    const g = graph([ticket('o/r#1')])
    expect(waves(g).get('o/r#1')).toBe(1)
  })

  it('each hand-off adds a wave', () => {
    const g = graph(
      [ticket('o/r#1'), ticket('o/r#2'), ticket('o/r#3')],
      [
        { blocked: 'o/r#2', by: 'o/r#1' },
        { blocked: 'o/r#3', by: 'o/r#2' },
      ],
    )
    const w = waves(g)
    expect(w.get('o/r#1')).toBe(1)
    expect(w.get('o/r#2')).toBe(2)
    expect(w.get('o/r#3')).toBe(3)
  })

  it('a finished blocker stops gating — its dependent is ready now', () => {
    const g = graph(
      [ticket('o/r#1', { state: 'closed' }), ticket('o/r#2')],
      [{ blocked: 'o/r#2', by: 'o/r#1' }],
    )
    expect(waves(g).get('o/r#2')).toBe(1)
  })

  it('takes the longest path when a ticket waits on several', () => {
    const g = graph(
      [ticket('o/r#1'), ticket('o/r#2'), ticket('o/r#3'), ticket('o/r#4')],
      [
        { blocked: 'o/r#2', by: 'o/r#1' },
        { blocked: 'o/r#3', by: 'o/r#2' },
        { blocked: 'o/r#4', by: 'o/r#1' },
        { blocked: 'o/r#4', by: 'o/r#3' },
      ],
    )
    expect(waves(g).get('o/r#4')).toBe(4)
  })

  it('terminates on a cycle instead of hanging', () => {
    const g = graph(
      [ticket('o/r#1'), ticket('o/r#2')],
      [
        { blocked: 'o/r#1', by: 'o/r#2' },
        { blocked: 'o/r#2', by: 'o/r#1' },
      ],
    )
    const w = waves(g)
    expect(w.get('o/r#1')).toBeGreaterThan(0)
    expect(w.get('o/r#2')).toBeGreaterThan(0)
  })

  it('waveOf agrees with waves for every ticket', () => {
    const g = graph(
      [ticket('o/r#1'), ticket('o/r#2')],
      [{ blocked: 'o/r#2', by: 'o/r#1' }],
    )
    for (const t of g.tickets) expect(waveOf(g, t.key)).toBe(waves(g).get(t.key))
  })
})

describe('gatedCount — the orb weight (#8)', () => {
  it('counts every open ticket stuck behind it', () => {
    const g = graph(
      [ticket('o/r#1'), ticket('o/r#2'), ticket('o/r#3')],
      [
        { blocked: 'o/r#2', by: 'o/r#1' },
        { blocked: 'o/r#3', by: 'o/r#2' },
      ],
    )
    expect(gatedCount(g, 'o/r#1')).toBe(2)
    expect(gatedCount(g, 'o/r#2')).toBe(1)
    expect(gatedCount(g, 'o/r#3')).toBe(0)
  })

  it('counts a diamond once, not twice', () => {
    const g = graph(
      [ticket('o/r#1'), ticket('o/r#2'), ticket('o/r#3'), ticket('o/r#4')],
      [
        { blocked: 'o/r#2', by: 'o/r#1' },
        { blocked: 'o/r#3', by: 'o/r#1' },
        { blocked: 'o/r#4', by: 'o/r#2' },
        { blocked: 'o/r#4', by: 'o/r#3' },
      ],
    )
    expect(gatedCount(g, 'o/r#1')).toBe(3)
  })

  it('stops at done — nothing behind a finished ticket is waiting on us', () => {
    const g = graph(
      [ticket('o/r#1'), ticket('o/r#2', { state: 'closed' }), ticket('o/r#3')],
      [
        { blocked: 'o/r#2', by: 'o/r#1' },
        { blocked: 'o/r#3', by: 'o/r#2' },
      ],
    )
    expect(gatedCount(g, 'o/r#1')).toBe(0)
  })

  it('is zero for a finished ticket — nothing is waiting on done work', () => {
    const g = graph(
      [ticket('o/r#1', { state: 'closed' }), ticket('o/r#2'), ticket('o/r#3')],
      [
        { blocked: 'o/r#2', by: 'o/r#1' },
        { blocked: 'o/r#3', by: 'o/r#2' },
      ],
    )
    expect(gatedCount(g, 'o/r#1')).toBe(0)
  })

  it('terminates on a cycle', () => {
    const g = graph(
      [ticket('o/r#1'), ticket('o/r#2')],
      [
        { blocked: 'o/r#1', by: 'o/r#2' },
        { blocked: 'o/r#2', by: 'o/r#1' },
      ],
    )
    expect(gatedCount(g, 'o/r#1')).toBe(1)
  })
})

describe('frontier — the "start here" set', () => {
  it('is the open, unclaimed tickets whose blockers are all done', () => {
    const g = graph(
      [
        ticket('o/r#1'),
        ticket('o/r#2'),
        ticket('o/r#3', { assignee: 'cmengu' }),
        ticket('o/r#4', { state: 'closed' }),
        ticket('o/r#5'),
      ],
      [
        { blocked: 'o/r#2', by: 'o/r#1' },
        { blocked: 'o/r#5', by: 'o/r#4' },
      ],
    )
    expect(frontier(g)).toEqual(['o/r#1', 'o/r#5'])
  })

  it('is sorted, so the pulsing set never depends on input order', () => {
    const g = graph([ticket('o/r#9'), ticket('o/r#2'), ticket('o/r#5')])
    expect(frontier(g)).toEqual(['o/r#2', 'o/r#5', 'o/r#9'])
  })
})

describe('chainOf — what lights up on hover', () => {
  it('returns the blocker trail, everything waiting, and the ticket itself', () => {
    const g = graph(
      [ticket('o/r#1'), ticket('o/r#2'), ticket('o/r#3'), ticket('o/r#4')],
      [
        { blocked: 'o/r#2', by: 'o/r#1' },
        { blocked: 'o/r#3', by: 'o/r#2' },
      ],
    )
    expect(chainOf(g, 'o/r#2')).toEqual(new Set(['o/r#1', 'o/r#2', 'o/r#3']))
  })

  it('includes done tickets — the trail is history, not just pending work', () => {
    const g = graph(
      [ticket('o/r#1', { state: 'closed' }), ticket('o/r#2')],
      [{ blocked: 'o/r#2', by: 'o/r#1' }],
    )
    expect(chainOf(g, 'o/r#2')).toEqual(new Set(['o/r#1', 'o/r#2']))
  })

  it('terminates on a cycle', () => {
    const g = graph(
      [ticket('o/r#1'), ticket('o/r#2')],
      [
        { blocked: 'o/r#1', by: 'o/r#2' },
        { blocked: 'o/r#2', by: 'o/r#1' },
      ],
    )
    expect(chainOf(g, 'o/r#1')).toEqual(new Set(['o/r#1', 'o/r#2']))
  })
})
