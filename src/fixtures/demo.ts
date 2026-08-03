/**
 * This repo's own tracker, so the first screen the Overviewer ever draws is its
 * own build plan.
 *
 * Step 1 typed these tickets out by hand. Step 2 reads `payloads/snapshot.json`
 * — the untouched response from a real GraphQL query against this repo — and
 * runs it through `ingest`. The export's type is identical either way, which is
 * the proof step 1's seam holds: everything behind this line changed
 * completely, and not one line of `derive`, `layout`, `render` or `main` moved.
 *
 * Recording it also corrected the hand-typed version, which had invented five
 * dependency edges that do not exist and claimed nobody was assigned when
 * thirteen issues are. That is decision 2 earning its keep: hand-written test
 * data encodes what you believe, and belief drifts.
 *
 * Step 3 added the live fetch beside this file rather than instead of it: the
 * demo is what boots when no token is saved, and how a live bug is reproduced
 * offline.
 */

import { readSnapshot, toDomainGraph } from '../ingest/ingest'
import type { DomainGraph } from '../domain/types'
import recorded from './payloads/snapshot.json'

export const demo: DomainGraph = toDomainGraph(readSnapshot(recorded))
