/**
 * The GraphQL request, as text. Pure string assembly — nothing here sends.
 *
 * Its real job is to be the one place the query text exists, so the recorded
 * fixture and the live path cannot slowly drift into asking GitHub different
 * questions: a test asserts `REPO_FIELDS` appears, token for token, inside
 * `record.sh`.
 *
 * `batchQuery` aliases each repo — `r0`, `r1`, `r2` — so ten repos cost one
 * request instead of ten. Measured at 20 rate-limit points for a 10-repo batch,
 * against a budget of 5,000 an hour.
 */

import type { RepoRef } from './config'
import type { RepoPayload } from '../ingest/payloads'
import { repoKey } from './config'

/**
 * The field selection inside a `repository { … }` block — exactly what the app
 * needs and nothing more. This is the same text `record.sh` uses, which is how
 * the fixture is kept honest by machine rather than by memory.
 */
export const REPO_FIELDS = `nameWithOwner
issues(first: 100, states: [OPEN, CLOSED], orderBy: {field: CREATED_AT, direction: ASC}) {
  nodes {
    number
    title
    state
    url
    assignees(first: 10) { nodes { login } }
    labels(first: 20) { nodes { name } }
    blockedBy(first: 50) { nodes { number repository { nameWithOwner } } }
  }
}
pullRequests(first: 100, states: [OPEN, MERGED, CLOSED]) {
  nodes {
    number
    title
    state
    url
    isDraft
    reviewDecision
    closingIssuesReferences(first: 10) { nodes { number repository { nameWithOwner } } }
  }
}`

/**
 * One GraphQL document plus its variables, covering every repo in one round
 * trip. The `rateLimit` field is the receipt: what the request actually cost,
 * read back into `PollCost` rather than guessed.
 */
export function batchQuery(repos: RepoRef[]): { query: string; variables: Record<string, string> } {
  const variables: Record<string, string> = {}
  const params: string[] = []
  const blocks: string[] = []

  repos.forEach((r, i) => {
    variables[`owner${i}`] = r.owner
    variables[`name${i}`] = r.name
    params.push(`$owner${i}: String!`, `$name${i}: String!`)
    blocks.push(`r${i}: repository(owner: $owner${i}, name: $name${i}) {\n${REPO_FIELDS}\n}`)
  })

  return {
    query: `query(${params.join(', ')}) {\n${blocks.join('\n')}\nrateLimit { cost }\n}`,
    variables,
  }
}

/**
 * Whatever came back over the wire, unpacked — and surviving partial failure.
 *
 * GraphQL answers `200` with some data and some errors: a repo you lack access
 * to arrives as `null` beside nine that arrived whole, and must not blank them.
 * Same honesty contract as `ingestProblems`: every repo that could not be read
 * gets a sentence, nothing is dropped silently.
 */
export function readBatch(body: unknown, repos: RepoRef[]): { repos: RepoPayload[]; problems: string[] } {
  const out: RepoPayload[] = []
  const problems: string[] = []

  const data = (body as { data?: Record<string, unknown> } | null)?.data
  const errors = (body as { errors?: { message?: unknown }[] } | null)?.errors
  const messages = Array.isArray(errors)
    ? errors.map((e) => (typeof e?.message === 'string' ? e.message : 'unnamed error'))
    : []

  if (data == null || typeof data !== 'object') {
    problems.push(`GitHub returned no data${messages.length ? ` — ${messages.join('; ')}` : ''}`)
    return { repos: out, problems }
  }

  repos.forEach((r, i) => {
    const repo = data[`r${i}`]
    if (repo == null) {
      problems.push(`${repoKey(r)}: not in the response — ${messages.join('; ') || 'no reason given'}`)
      return
    }
    out.push(repo as RepoPayload)
  })

  return { repos: out, problems }
}
