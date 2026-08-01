# GitHub API facts for Overviewer — verified 2026-08-01

Research ticket: pin down the API surface a stateless browser app needs for a multi-repo kanban×DAG over GitHub issues/PRs. All claims below are from primary sources (docs.github.com, github.blog/changelog) or live probes against api.github.com run on 2026-08-01 with the `gh`-authenticated account `cmengu` (classic OAuth token). Probe transcripts at the bottom.

## TL;DR — load-bearing facts

- **Native dependencies exist and are GA** (changelog 2025-08-21). GraphQL: `Issue.blockedBy` / `Issue.blocking` / `Issue.issueDependenciesSummary`, mutations `addBlockedBy` / `removeBlockedBy`. REST: `…/issues/{n}/dependencies/blocked_by|blocking`. Limit: **50 issues per relationship type per issue**. Verified live against the schema.
- **CORS works from the browser** for both REST and `/graphql`: `Access-Control-Allow-Origin: *`, `Authorization` in allowed headers, `ETag` exposed. Verified live with OPTIONS preflights.
- **Sub-issues are GA**: `Issue.parent` / `Issue.subIssues` / `Issue.subIssuesSummary`, mutations `addSubIssue` / `removeSubIssue` / `reprioritizeSubIssue`, full REST surface. Limits: **100 sub-issues per parent, 8 nesting levels**.
- **Polling budget is comfortable**: a realistic batched 10-repo GraphQL poll (100 issues + 50 PRs per repo, with nested blockedBy/subIssues) **cost 20 points, measured live**. At 30 s polling that is 2,400 points/hr vs the 5,000/hr budget. REST conditional requests returning 304 **do not count** (verified live: `x-ratelimit-used` unchanged).
- **GraphQL does not support conditional requests** — no `ETag`/`Cache-Control` on `/graphql` responses (verified live). Every poll costs points; there is no 304 shortcut on GraphQL.

### Red flags

1. **Projects v2 access is the auth weak point.** GraphQL ProjectV2 fields (`projectItems`, `ProjectV2` etc.) require the classic-token `read:project` / `project` scope — verified live: this account's token (`repo, read:org, gist`) got `INSUFFICIENT_SCOPES` on every ProjectV2 field. For **fine-grained PATs**, the "Projects" permission is listed **at organization level only** in the permissions reference; the docs' Projects-API tutorial names only classic PATs and GitHub App installation tokens. If Overviewer's Status column lives in a *user-owned* project and the user brings a fine-grained PAT, project reads/writes may fail. Mitigation: support classic PAT with `project` scope, or use the newer **Projects v2 REST API** (`/orgs/{org}/projectsV2/…`, `/users/{username}/projectsV2/…`, added Sept 2025) which is covered by fine-grained org "Projects" permission — but verify user-level REST coverage with the actual token type before committing.
2. **Cross-organization dependencies are not supported** (same-org / same-repo network only, per community feedback threads referenced from the changelog; the docs are silent on exact cross-repo scope). If Overviewer spans repos across orgs, blocked-by edges cannot cross the org boundary. Test with the real repo set.
3. **Issue dependencies are not on GHES-only plans list**: docs say available on Free, Pro, Team, GHEC. Fine for github.com use.
4. **Mutations count 5 points each toward the secondary limit** (2,000 points/min for GraphQL). Irrelevant at Overviewer's scale but caps burst drag-and-drop writes at ~400 mutations/min.
5. **Auto-add workflows are plan-limited by count**: Free = 1, Pro/Team = 5, GHEC/GHES = 20 per project.

---

## 1. Native issue dependencies (blocked-by / blocking)

**GraphQL fields on `Issue`** (verified via live introspection):

- `blockedBy` — connection of issues blocking this issue
- `blocking` — connection of issues this issue blocks
- `issueDependenciesSummary` — `{ blockedBy, blocking, totalBlockedBy, totalBlocking }` (cheap counts, ideal for badges)

**Mutations** (verified via live introspection):

- `addBlockedBy(input: { issueId: ID!, blockingIssueId: ID! })`
- `removeBlockedBy(input: { issueId: ID!, blockingIssueId: ID! })`

There is no separate "addBlocking" mutation — model everything as blocked-by edges (to mark A as blocking B, call `addBlockedBy(issueId: B, blockingIssueId: A)`).

**REST endpoints** ([REST API endpoints for issue dependencies](https://docs.github.com/en/rest/issues/issue-dependencies)):

- `GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by`
- `POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by`
- `DELETE /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by/{issue_id}`
- `GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocking`

Pagination `per_page` max 100. POST/DELETE carry a secondary-rate-limit warning for rapid content creation.

**Limits**: "You can link up to 50 issues for each relationship type" — [Dependencies on issues changelog, 2025-08-21](https://github.blog/changelog/2025-08-21-dependencies-on-issues/) (GA announcement; also announced REST + GraphQL + webhook support and the `is:blocked` / `is:blocking` / `blocked-by:` / `blocking:` search filters).

**Permissions**: "People with at least triage permissions for a repository can create issue dependencies" — [Creating issue dependencies](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies) (docs frontmatter). Fine-grained PAT: the REST dependency endpoints are listed under **"Issues" repository permission** — read for GETs, write for POST/DELETE — in [Permissions required for fine-grained PATs](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens).

**Cross-repo**: the UI/docs let you pick issues from other repositories; community feedback threads linked from the GA changelog report that **cross-organization** dependencies are rejected (`FORBIDDEN` on `addBlockedBy` outside the org/enterprise). The official docs do not state the exact boundary — treat "same org" as the safe assumption and verify against the target repo set.

**Plan availability**: Free, Pro, Team, GHEC ([Creating issue dependencies](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies), `product` frontmatter).

`gh` CLI also supports it natively: `gh issue create/edit --blocked-by/--blocking/--add-blocked-by/…` and `gh issue view --json blockedBy,blocking` (same docs page).

## 2. Browser CORS

Docs statement: **"The REST API supports cross-origin resource sharing (CORS) for AJAX requests from any origin."** — [Using CORS and JSONP to make cross-origin requests](https://docs.github.com/en/rest/using-the-rest-api/using-cors-and-jsonp-to-make-cross-origin-requests). The page does not mention `/graphql`, so this was verified live (see probes): **both** `https://api.github.com/graphql` and REST paths answer OPTIONS preflight with:

- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Headers: Authorization, Content-Type, If-Match, If-Modified-Since, If-None-Match, If-Unmodified-Since, … X-GitHub-Api-Version, …`
- `Access-Control-Allow-Methods: GET, POST, PATCH, PUT, DELETE`
- `Access-Control-Expose-Headers: ETag, Link, … X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Used, X-RateLimit-Resource, X-RateLimit-Reset, X-Poll-Interval, …`
- `Access-Control-Max-Age: 86400`

Consequences for Overviewer: a fine-grained (or classic) PAT in an `Authorization: Bearer` header works directly from browser JS for both APIs; the rate-limit and `ETag`/`Link` headers are readable from JS (exposed); preflights are cached 24 h.

## 3. Projects v2 Status via API

Source: [Using the API to manage Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects) (all mutation shapes below also verified against the live schema).

**Read Status**: query the item's `fieldValues`; a single-select value comes back as `ProjectV2ItemFieldSingleSelectValue` with fields `name`, `optionId`, `color`, `field { … name }` (live introspection: also `nameHTML`, `description`, `databaseId`, etc.). Status is just the built-in single-select field named "Status".

**Add an issue to a project**: `addProjectV2ItemById(input: { projectId, contentId })` → `item { id }`. Docs note: "You cannot add and update an item in the same call" — add first, then update.

**Set Status**: `updateProjectV2ItemFieldValue(input: { projectId, itemId, fieldId, value: { singleSelectOptionId: "OPTION_ID" } })`. `ProjectV2FieldValue` input accepts `text | number | date | singleSelectOptionId | multiSelectOptionIds | iterationId` (live introspection — note `multiSelectOptionIds` now exists). You cannot set Assignees/Labels/Milestone/Repository this way (they are issue properties, not project fields).

**Auth**: docs say token needs classic scope `read:project` (queries) or `project` (mutations); classic PAT or GitHub App installation token. Verified live: a classic token without the scope gets `INSUFFICIENT_SCOPES` on every ProjectV2 field. Fine-grained PATs: only an **organization-level "Projects" permission** appears in the permissions reference, covering the REST `/orgs/{org}/projectsV2/…` endpoints ([permissions reference](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)). A REST Projects v2 API also exists ([REST: Projects](https://docs.github.com/en/rest/projects/projects), [items](https://docs.github.com/en/rest/projects/items), [fields](https://docs.github.com/en/rest/projects/fields)) including `/users/{username}/projectsV2` — added September 2025 — and is the fine-grained-PAT-friendly path.

**Built-in workflow automations** ([Using the built-in automations](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-built-in-automations) + linked pages):

- Enabled by default on every new project: **issue/PR closed → Status = Done**, **PR merged → Status = Done**.
- Configurable Status-setting workflows on events, e.g. **item added to project → Status = Todo** (docs' own example), item reopened, etc. — the docs page describes the category ("update the Status of items based on certain events") without enumerating every default workflow; the project's Workflows UI (and the GraphQL `ProjectV2.workflows` connection — type `ProjectV2Workflow { name, enabled, number }`, verified in schema) is the authoritative list per project.
- **Auto-close issue**: "close issues when the issue's status in your project is changed" (same page).
- **Auto-add to project** ([Adding items automatically](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/adding-items-automatically)): adds newly created/updated repo items matching a filter (`is`, `label`, `reason`, `assignee`, `no`; negation supported). Does not backfill existing items. **Plan-limited count of auto-add workflows: Free 1, Pro 5, Team 5, GHEC 20, GHES 20.**
- **Auto-archive items** ([Archiving items automatically](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/archiving-items-automatically)): filters `is`, `reason`, `updated` (e.g. `updated:<@today-2w`); archives matching items including pre-existing ones.

Net for Overviewer: without the app doing anything, GitHub itself will move items to **Done** on close/merge, set an initial Status on add (if enabled), add matching new items to the project, archive stale items, and close issues when Status changes. The app must therefore treat project Status as writable by GitHub between polls, not as app-owned state.

## 4. Sub-issues

**GraphQL** (verified via live introspection): `Issue.parent`, `Issue.subIssues` (connection), `Issue.subIssuesSummary { total, completed, percentCompleted }`. Mutations: `addSubIssue(input: { issueId, subIssueId, subIssueUrl, replaceParent })`, `removeSubIssue`, `reprioritizeSubIssue`.

**REST** ([REST API endpoints for sub-issues](https://docs.github.com/en/rest/issues/sub-issues)):

- `GET /repos/{owner}/{repo}/issues/{issue_number}/parent`
- `GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues`
- `POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues` (`sub_issue_id`, optional `replace_parent`)
- `DELETE /repos/{owner}/{repo}/issues/{issue_number}/sub_issue` (`sub_issue_id`)
- `PATCH /repos/{owner}/{repo}/issues/{issue_number}/sub_issues/priority` (`sub_issue_id`, `after_id`/`before_id`)

Fine-grained PAT: all under **"Issues" repository permission** (read for GETs, write for POST/DELETE/PATCH) — [permissions reference](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens).

**Limits** ([Adding sub-issues](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues)): "You can add up to **100 sub-issues per parent issue**" and "create up to **eight levels** of nested sub-issues". Cross-repo sub-issues are supported (the add dialog lets you pick another repository). GA announced in [Evolving GitHub Issues and Projects, 2025-04-09](https://github.blog/changelog/2025-04-09-evolving-github-issues-and-projects/).

## 5. Rate-limit budget for polling

**Primary limits**:

- REST: **5,000 requests/hr** per authenticated user (15,000 for GHEC users) — [Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).
- GraphQL: **5,000 points/hr** per user. Cost formula: add up the requests needed per unique connection, **divide by 100, round; minimum 1 point**. Node cap 500,000 per query; every connection needs `first`/`last` (1–100) — [GraphQL rate and node limits](https://docs.github.com/en/graphql/overview/rate-limits-and-node-limits-for-the-graphql-api). Check via `rateLimit { cost remaining resetAt }` in-query or `x-ratelimit-*` headers (resource = `graphql`, a **separate bucket** from REST `core` — confirmed live via `x-ratelimit-resource`).

**Conditional requests**: "Making a conditional request does not count against your primary rate limit if a `304` response is returned and the request was made while correctly authorized with an `Authorization` header" — [Best practices for using the REST API](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api). **Verified live**: repeated GET with `If-None-Match` returned 304 and `x-ratelimit-used` did not increment. **GraphQL responses carry no `ETag`/`Cache-Control` header (verified live) — no conditional-request escape hatch on GraphQL.**

**Secondary limits** ([about secondary rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#about-secondary-rate-limits)): max 100 concurrent requests; **900 points/min for REST** and **2,000 points/min for GraphQL** (GET/HEAD/OPTIONS = 1 pt, POST/PATCH/PUT/DELETE = 5 pts, GraphQL query = 1 pt, GraphQL mutation = 5 pts); 90 s CPU per 60 s; **80 content-generating requests/min and 500/hr** (relevant if the app bulk-creates dependencies/sub-issues).

**Measured budget** (live probe): one batched query over **10 repo aliases**, each fetching `issues(first:100)` with nested `blockedBy(first:20)` + `subIssues(first:20)` and `pullRequests(first:50)`, plus `rateLimit`, cost **20 points** (matches the formula: ~10+10 top-level + 2×10×100 nested = 2,020 sub-requests / 100 ≈ 20).

| Poll interval | Polls/hr | Points/hr | % of 5,000 budget |
|---|---|---|---|
| 30 s | 120 | 2,400 | 48% |
| 45 s | 80 | 1,600 | 32% |
| 60 s | 60 | 1,200 | 24% |

Adding `projectItems(first:5)` per issue adds ~10 pts/poll (→30 pts; 3,600/hr at 30 s — still fits). Headroom: at 30 s polling, ~2,600 points/hr remain for mutations and detail queries; secondary limits are nowhere near binding (2 queries/min vs 2,000 points/min). Recommendation: 45–60 s polling, cheap `issueDependenciesSummary`/`subIssuesSummary` counts in the poll, full edge lists fetched on demand.

## Verified live (probes run 2026-08-01, account `cmengu`, classic OAuth token `repo, read:org, gist`)

1. **Issue fields introspection** — `gh api graphql -f query='{__type(name:"Issue"){fields{name}}}'` filtered for block/depend/sub/parent → `blockedBy, blocking, issueDependenciesSummary, parent, subIssues, subIssuesSummary`.
2. **Mutation introspection** — same on `Mutation` → `addBlockedBy, removeBlockedBy, addSubIssue, removeSubIssue, reprioritizeSubIssue, addProjectV2ItemById, updateProjectV2ItemFieldValue, clearProjectV2ItemFieldValue, archiveProjectV2Item, deleteProjectV2Item, updateProjectV2ItemPosition`. (Note: introspection queries are capped at 2 uses of `__Type.fields`/`inputFields` per request — `INTROSPECTION_LIMIT_EXCEEDED` otherwise.)
3. **Input/output type introspection** — `AddBlockedByInput { issueId: ID!, blockingIssueId: ID! }`; `IssueDependenciesSummary { blockedBy, blocking, totalBlockedBy, totalBlocking }`; `SubIssuesSummary { completed, percentCompleted, total }`; `ProjectV2FieldValue { text, number, date, singleSelectOptionId, multiSelectOptionIds, iterationId }`; `AddSubIssueInput { issueId, subIssueId, subIssueUrl, replaceParent }`; `ProjectV2ItemFieldSingleSelectValue` fields incl. `name, optionId, color, field`.
4. **CORS preflights** — `curl -i -X OPTIONS https://api.github.com/graphql -H "Origin: https://example.com" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: authorization,content-type"` → `204` with `access-control-allow-origin: *`, Authorization in allow-headers. Identical result for `OPTIONS /repos/octocat/hello-world/issues`.
5. **GraphQL has no ETag** — `curl -D - -X POST https://api.github.com/graphql … '{"query":"query{viewer{login}}"}'` → headers contain `x-ratelimit-resource: graphql` but no `etag`/`cache-control`.
6. **REST 304 is free** — `GET /repos/github/docs/issues?per_page=1` → `etag: "2a01e0…"`, `x-ratelimit-used: 6`; repeat with `If-None-Match` → `status=304`, `x-ratelimit-used: 6` (unchanged).
7. **Batched poll cost** — 10-alias repository query as described above → `{"cost":20,"limit":5000}`. A single-repo variant (50 issues + 50 PRs, `blockedBy(first:10)`/`subIssues(first:10)`) → `cost: 1`.
8. **ProjectV2 scope failure** — any query touching `projectsV2`/`projectItems`/`workflows` → `INSUFFICIENT_SCOPES: The 'id' field requires one of the following scopes: ['read:project'], but your token has only been granted: ['gist', 'read:org', 'repo']`. This is the red-flag #1 evidence.
