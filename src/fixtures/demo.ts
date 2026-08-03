/**
 * This repo's own tracker, typed out by hand as a snapshot — so the first
 * screen the Overviewer ever draws is its own build plan.
 *
 * Every row below is a real issue with its real state as of 2026-08-03. Step 3
 * replaces this file with a live GitHub fetch and nothing else changes; because
 * it is typed, the compiler already checks it against the shape step 2's ingest
 * has to produce.
 *
 * Known gap, kept honest: no ticket here is assigned and none has an open PR,
 * because none does on GitHub today. So the `in-progress` and `in-review`
 * columns render empty until real data arrives. Those two rules are covered by
 * `test/derive.test.ts` rather than by this snapshot.
 */

import type { DomainGraph, Ticket } from '../domain/types'

const REPO = 'cmengu/Github_Kanban'

const issue = (
  number: number,
  title: string,
  state: 'open' | 'closed',
  labels: string[] = [],
): Ticket => ({
  key: `${REPO}#${number}`,
  title,
  state,
  assignee: null,
  labels,
  prs: [],
  url: `https://github.com/${REPO}/issues/${number}`,
})

export const demo: DomainGraph = {
  tickets: [
    issue(2, 'Prototype: does the rank=bucket fused layout actually work?', 'closed', ['wayfinder:prototype']),
    issue(4, 'Decision: where do buckets live — Projects v2 Status or derived from state?', 'closed', ['wayfinder:grilling']),
    issue(10, 'Research: GitHub API facts the spec depends on', 'closed', ['wayfinder:research']),
    issue(12, 'Decision: auth, hosting, and liveness — PAT + static + polling?', 'closed', ['wayfinder:grilling']),
    issue(13, 'Decision: the stack — React Flow + dagre/ELK + Vite + TypeScript?', 'closed', ['wayfinder:grilling']),
    issue(15, 'Decision: live-refresh layout stability — re-layout each poll, or pin positions?', 'closed', ['wayfinder:grilling']),
    issue(14, 'Wayfinder map: Overviewer', 'open', ['wayfinder:map']),
    issue(16, 'Spec: Overviewer v2 — two-projection star-map viewer over GitHub-native ticket DAGs', 'open', ['ready-for-agent']),
  ],
  edges: [
    // The map could not close until its decision tickets did.
    { blocked: `${REPO}#14`, by: `${REPO}#4` },
    { blocked: `${REPO}#14`, by: `${REPO}#13` },
    { blocked: `${REPO}#14`, by: `${REPO}#15` },
    { blocked: `${REPO}#14`, by: `${REPO}#12` },
    // The spec was regenerated from the completed map.
    { blocked: `${REPO}#16`, by: `${REPO}#14` },
    // The prototype and the research fed the decisions that fed the map.
    { blocked: `${REPO}#13`, by: `${REPO}#2` },
    { blocked: `${REPO}#12`, by: `${REPO}#10` },
  ],
}
