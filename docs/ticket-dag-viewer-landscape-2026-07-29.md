# Ticket-DAG Viewer — Prior-Art Landscape (2026-07-29)

Concept being checked: a web app that (1) aggregates GitHub issues **and** PRs across many repos, (2) batch-creates tickets across projects, (3) renders each project's tickets as a **persistent dependency DAG whose nodes move through workflow buckets** (backlog → in progress → PR open/review → done) without the graph ever collapsing into a plain column view, and (4) exists to allocate human attention (architecture, review) vs. free-running AI execution.

All claims below cite the primary source that owns them.

---

## TL;DR verdict

**No existing tool does the fused view.** Every ingredient exists separately, but the specific fusion — kanban-buckets × persistent-DAG, per project, over *GitHub* issues, multi-repo, with PR state folded into node status — is unoccupied:

- **GitHub itself** now owns all the *data*: native cross-repo issue dependencies (GA Aug 2025), full GraphQL/REST/CLI support, multi-repo Projects v2 — but renders dependencies only as sidebar lists and a "Blocked" icon, never as a graph ([changelog](https://github.blog/changelog/2025-08-21-dependencies-on-issues/), [docs](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies)).
- **beads** (Steve Yegge) is the closest *philosophy* match — a dependency-DAG issue tracker built for AI coding agents — but it is its own tracker (not GitHub issues), CLI-first with no built-in UI ([repo](https://github.com/steveyegge/beads)). Its community viewers render kanban **and** a DAG, but as **separate tabs**, single-project ([bead-me-up-scotty](https://github.com/brendan-appstart/bead-me-up-scotty), [beads-viewer](https://github.com/mgalpert/beads-viewer)).
- **moul/depviz** is the closest *GitHub-issue* match — multi-repo aggregation + dependency graph + ready/blocked queries in a web UI — but it is a graph/roadmap explorer, not a status-bucketed board, with no batch creation and niche adoption (~155 stars) ([repo](https://github.com/moul/depviz)).
- Everything else is either **timeline dependency lines, not DAGs** (ZenHub, Jira Advanced Roadmaps, Linear, Plane), **DAGs of PRs, not issues** (Graphite, av, ghstack), or **agent-session managers with no dependency model at all** (Conductor, Claude Squad, Factory, Devin) — and that last space is churning hard (Vibe Kanban sunsetting, Terragon shut down Jan 2026, Crystal deprecated Feb 2026, Height dead Sep 2025).

**Novelty verdict: a thin-but-genuinely-unbuilt composition.** The idea is not deep-tech novel — it is GitHub's own dependency data + a dagre/React-Flow layout + a status-to-color mapping. But nobody ships it, and the one tool that proves people want it (beads' ecosystem sprouting four community graph UIs in months) targets the wrong backend for this user's multi-repo GitHub workflow. Building it is justified; building it *from scratch except the data layer* is not — GitHub's API does all the heavy lifting.

---

## A. GitHub native

### Issue dependencies (blocked-by / blocking)
- **GA since 21 Aug 2025**: "specify which issues are blocked by or blocking others… open the Relationships section in the issues sidebar… link up to 50 issues for each relationship type." Available on all plans incl. Free. — [GitHub Changelog](https://github.blog/changelog/2025-08-21-dependencies-on-issues/)
- **Cross-repository dependencies are supported** (with restrictions only for Enterprise Managed Users) — [changelog](https://github.blog/changelog/2025-08-21-dependencies-on-issues/), [public-preview discussion](https://github.com/orgs/community/discussions/165749). This is the critical enabler for the multi-repo DAG: the edges can live in GitHub itself.
- **Full API surface**: GraphQL `blockedBy(first: 100)` / `blocking(first: 100)` fields and mutations; REST endpoints for listing/adding/removing dependencies; webhooks — [REST docs](https://docs.github.com/en/rest/issues/issue-dependencies), [GraphQL reference](https://docs.github.com/en/graphql/reference/issues), [preview discussion](https://github.com/orgs/community/discussions/165749).
- **CLI since 10 Jun 2026**: `gh issue create --blocked-by/--blocking` and `gh issue edit --add/remove-blocked-by/-blocking`, plus `--json blockedBy,blocking` — [changelog](https://github.blog/changelog/2026-06-10-manage-sub-issues-types-and-dependencies-from-github-cli/), [cli/cli#11757](https://github.com/cli/cli/issues/11757).

### Projects v2
- **Multi-repo, even cross-org aggregation**: "You can include issues and pull requests from any organization"; `addProjectV2ItemById` accepts items from other orgs — [Adding items to your project](https://docs.github.com/en/issues/planning-and-tracking-with-projects/managing-items-in-your-project/adding-items-to-your-project), [Feb 2023 changelog](https://github.blog/changelog/2023-02-23-github-issues-projects-february-23rd-update/). Aggregation of issues **and PRs** into one board is fully solved natively.
- **Dependency visualization: none.** Blocked issues get a "Blocked" **icon** on project boards and the repo Issues page — that is the entire visual treatment ([changelog](https://github.blog/changelog/2025-08-21-dependencies-on-issues/), [docs](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies)). No graph render in board, table, or roadmap view. The roadmap item that framed the ambition ("visualize the sequence in which issues need to be addressed… reflected in your project views") was **closed as not planned** in that form — [github/roadmap#956](https://github.com/github/roadmap/issues/956); what shipped is the sidebar-list + icon version.
- **Batch creation**: no native cross-repo batch-create. Scriptable via `gh` / GraphQL.

**Gap vs. concept**: owns 100% of the data (items 1, edges for 3, plumbing for 2) and 0% of the visualization (item 3). No graph, no DAG-with-buckets, no attention-allocation lens.

---

## B. GitHub issue-dependency graph visualizers

### moul/depviz — "dependency visualizer for GitHub & GitLab (a.k.a. auto-roadmap)"
- Aggregates issues **across multiple repos** from GitHub and GitLab; also manual edges (`depviz edge add`) and a markdown-ish "DepViz Flow" format (`#679 depends on #80, #81`); "With GitHub sync/export… GitHub owns titles, labels, and state" — [repo](https://github.com/moul/depviz).
- Shows node state (open/closed) and answers exactly the user's question with **ready/blocker queries**: "What can move now? What is blocked?" — [repo](https://github.com/moul/depviz).
- Web UI (`depviz live` "serves a stateless browser app") + CLI (`depviz brief`, `depviz gen json/html`). Active v4 rewrite, 741 commits, ~155 stars — [repo](https://github.com/moul/depviz).
- **Gap**: graph/roadmap view only — no kanban-bucket dimension fused into the graph; no PR aggregation as first-class nodes; no batch ticket creation; predates/ignores GitHub's native dependency API (uses its own edge store + body syntax); small project.

### maxim-lobanov/build-issue-dependencies-graph (GitHub Action)
- Parses "Depends on <issue URL>" lines in child issues of an epic, renders a **mermaid flowchart into the epic issue body**, and — notably — **colors nodes by status**: "Green (closed), Yellow (open + assigned), White (open, unassigned)" — [repo](https://github.com/maxim-lobanov/build-issue-dependencies-graph). This is the exact status-on-DAG rendering idea, in miniature.
- **Gap**: static (regenerated by Action), per-epic scope, same-repo examples only, no board/buckets, no interaction, 8 stars.

### k-nasa/gid
- CLI/Action giving "easy-to-understand views of github issue dependencies" via GitHub's built-in mermaid rendering — [repo](https://github.com/k-nasa/gid). Same static-mermaid category as above.

### hjylewis/issue-graph
- "A graphical view of the relationships between github issues… throughout an organization's or user's repos"; detects edges from `[org/repo]#issuenum` references in issue bodies; nodes colored **by repo**; group by assignee/repo/milestone — [repo](https://github.com/hjylewis/issue-graph). Multi-repo graph, but relationship ≠ dependency semantics, no status buckets, dormant (16 stars, pre-dates native dependencies).

### kazuhito-m/github-issue-dependency-graph, tal/github-graph, gh-deps
- `kazuhito-m/github-issue-dependency-graph` now returns **404** (deleted or renamed) — [dead link](https://github.com/kazuhito-m/github-issue-dependency-graph). No maintained successor found under that name. `tal/github-graph` and a canonical "gh-deps" did not surface as live, citable projects in searches; the ecosystem's live representatives are the four above. (Recorded as negative results.)

### ZenHub
- GitHub-native (multi-repo workspaces on top of GitHub issues), has issue dependencies ("visualization of task relationships… see what tasks they're waiting on") — [ZenHub blog](https://blog.zenhub.com/github-issue-dependencies/).
- Roadmap/timeline shows **dependency arrows between Epics** on a Gantt-style timeline; dependency lines in Timeline view — [roadmap enhancements](https://www.zenhub.com/blog-posts/enhancements-to-roadmaps), [changelog](https://changelog.zenhub.com/), [roadmaps help](https://help.zenhub.com/support/solutions/articles/43000539465-getting-started-with-zenhub-roadmaps).
- **Gap**: dependency *lines on a timeline* (epic-level), not a free-form per-project ticket DAG; board view and dependency view are separate; commercial/team-oriented; no AI-agent attention framing.

---

## C. AI-agent-era orchestration tools (closest space)

### steveyegge/beads (bd)
- "Distributed issue tracker for AI coding agents… replaces messy markdown plans with a **dependency-aware graph**"; hash-based IDs for multi-agent merge safety; Dolt-backed; link types beyond blocking (relates-to, duplicates, supersedes, replies-to) — [repo](https://github.com/steveyegge/beads).
- **Deliberately has no built-in UI** — text/CLI/JSON-first for agents; community builds the viewers — [Beads UI discussion #276](https://github.com/steveyegge/beads/discussions/276).
- Per-project (`bd init`), syncs via git remotes; **no GitHub Issues sync** in the README — [repo](https://github.com/steveyegge/beads).
- **Gap**: right dependency model, wrong substrate for this user — tickets are beads records, not GitHub issues across many repos, so PRs/review state and cross-repo aggregation are out of scope.

### beads community viewers — proof of demand, and proof the fusion is still missing
- **brendan-appstart/bead-me-up-scotty**: "board, epics, dependency graph, drag-and-drop"; 5-column kanban (Backlog·Ready·In Progress·Blocked·Done) **and** a React-Flow dependency graph with drag-to-link — but "these are separate interfaces; the status columns and dependency DAG exist in **different views**." Single `.beads` dir, no GitHub — [repo](https://github.com/brendan-appstart/bead-me-up-scotty).
- **mgalpert/beads-viewer**: tabs for Issue List / Kanban Board / **Dependency Graph** (blocking = red animated edges) / Ready Work filter; WebSocket live-sync; single project, no GitHub — [repo](https://github.com/mgalpert/beads-viewer).
- **assimelha/bdui** (TUI: Kanban, Tree, **Graph** views) and **maphew/beady** (minimal web UI) — [bdui](https://github.com/assimelha/bdui), [beady](https://github.com/maphew/beady).
- **Reading**: four independent viewers appeared around one CLI tracker, and *every one of them* keeps board and graph as separate views. The kanban×DAG fusion the user wants doesn't exist even here, where the audience is exactly "solo dev orchestrating agents."

### Vibe Kanban (BloopAI/vibe-kanban)
- Kanban for orchestrating 10+ coding agents (Claude Code, Codex, …): plan issues on a board, agent workspaces with git branch/terminal/dev-server, inline diff review, PR creation/merge — [repo](https://github.com/BloopAI/vibe-kanban).
- **No task dependencies or DAG view** documented; multi-repo unclear. **Sunsetting** per its own README banner — [repo](https://github.com/BloopAI/vibe-kanban).

### Backlog.md (MrLesk/Backlog.md)
- "Markdown-native Task Manager & Kanban visualizer for any Git repository"; spec/plan/code review checkpoints; terminal kanban + web UI with drag-and-drop; supports "milestones & dependencies"; MCP for Claude Code et al. — [repo](https://github.com/MrLesk/Backlog.md).
- **Gap**: single-repo, tasks are local .md files not GitHub issues, no documented dependency-graph rendering, no multi-project aggregation.

### Session managers — no dependency model at all
- **Conductor** (Mac app): "Run parallel Claude Code, Codex, and Cursor agents in isolated workspaces… see at a glance what they're working on, then review and merge" — no kanban/dependency/DAG features on the product page — [conductor.build](https://conductor.build/).
- **Claude Squad**: open-source terminal app (tmux + git worktrees) managing multiple local agents in isolated workspaces; background/auto-accept mode — no task graph — [repo](https://github.com/smtg-ai/claude-squad).
- **Crystal (stravu/crystal)**: parallel Claude Code/Codex sessions in worktrees — **deprecated Feb 2026**, replaced by Nimbalyst; no kanban/DAG mentioned — [repo](https://github.com/stravu/crystal).
- **Terragon**: remote background-agent orchestrator — **shut down 16 Jan 2026**, code released as terragon-oss — [repo](https://github.com/terragon-labs/terragon-oss).
- **Claude Code Agent View** (May 2026): one dashboard for every background session (`/bg`, `claude --bg`) — session list, not a work graph — [guide](https://claudefa.st/blog/guide/agents/agent-view).
- **Factory.ai**: desktop app runs multiple Droids, sessions in sidebar with context/progress/history; "Missions" fan out worker agents — no user-facing task-dependency DAG dashboard — [Factory Desktop](https://factory.ai/news/factory-desktop). Devin similarly exposes parallel sessions, not a dependency graph.
- **Reading**: this layer manages *agent sessions*; none of it models *work structure*. The user's concept sits one layer up (planning/attention), which is exactly the layer the beads ecosystem is groping toward. Also note the mortality rate in this space (Vibe Kanban, Terragon, Crystal, Height) — the session-manager layer is being commoditized by first-party features like Claude Code's Agent View.

---

## D. PM tools with dependency support

### Linear
- Issue-level blocks / blocked-by / related relations since 2020 — [changelog tweet](https://x.com/linear/status/1235294604787937291), managed from the issue sidebar.
- **Graph rendering exists only at project level, on a timeline**: "lines connecting the blocked and blocking projects" (blue ok / red violated) — [Project dependencies docs](https://linear.app/docs/project-dependencies). No issue-level graph view; third-party CLI tools fill the gap ([aspiers/linear-tools#4](https://github.com/aspiers/linear-tools/issues/4)).
- GitHub integration: repo↔team **two-way issue sync** (title, description, status, labels, assignee, comments; new issues only, historical via import) + PR linking/auto-close — [GitHub integration docs](https://linear.app/docs/github-integration), [GitHub Issues Sync changelog](https://linear.app/changelog/2023-12-14-github-issues-sync).
- **Gap**: could aggregate multi-repo GitHub issues via sync, and has the relations — but no issue DAG render at all, and the board vs. dependency data never meet visually.

### Plane (open source)
- AGPL Community Edition; board/table/calendar/Gantt views; "issues and their dependencies are displayed on a **timeline**" — [plane.so/open-source](https://plane.so/open-source), [Plane blog](https://plane.so/blog/top-6-open-source-project-management-software-in-2026). Gantt lines, no free-form DAG; GitHub sync is an integration, not the substrate.

### Huly
- Open-source (EPL-2.0) all-in-one; Tracker has "Mark as blocked by" relations — [Related and blocking issues docs](https://docs.huly.io/task-tracking/related-issues/).
- **Real two-way GitHub sync incl. multiple repos and GitHub Projects**: "Any issue created in your GitHub repository will automatically appear as a task on your Huly project board… create an issue in Huly and it will be synced back" — [Huly GitHub docs](https://docs.huly.io/integrations/github/).
- **Gap**: no dependency-graph rendering documented — relations are sidebar fields. But Huly is the strongest existing "aggregate many GitHub repos into one board with two-way sync" today, i.e., it solves item 1 and half of item 2, none of item 3.

### Height — **dead**
- Shut down 24 Sep 2025 (announced Mar 2025), workspaces deleted, no migration path — [AlternativeTo news](https://alternativeto.net/news/2025/3/height-project-management-tool-to-shut-down-by-september-2025/), [creativerly](https://www.creativerly.com/height-app-is-shutting-down/). Its "autonomous PM" pitch (AI triage, auto-updating specs) is a cautionary tale for the adjacent positioning.

### Jira (Advanced Roadmaps / Plans)
- The **Dependencies report** "displays issues from your plan as **tiles with arrows**" — the closest thing to an actual issue-dependency map in a mainstream PM tool; plus dependency arrows/badges on Timeline (gray ok / red warning) — [Atlassian support: dependencies report](https://support.atlassian.com/jira-software-cloud/docs/what-is-the-dependencies-report-in-advanced-roadmaps/), [dependencies map (DC)](https://confluence.atlassian.com/jiraportfolioserver/displaying-the-dependencies-map-1005805794.html).
- **Gap**: Jira issues only — GitHub integration links commits/branches/PRs to Jira issues, it does not make GitHub issues the tickets; report is a diagnostic view, not a live board; heavyweight for a solo dev.

### GitLab
- blocks / is-blocked-by links (Premium+), cross-project (`group/project#44`), blocked **icon** on lists and boards; "no dedicated graph visualization" in the docs — [GitLab linked issues docs](https://docs.gitlab.com/ee/user/project/issues/related_issues.html). (GitLab's DAG views exist for CI pipelines, not issues.) Different forge anyway.

---

## E. Stacked-PR tools (PR DAGs, not issue DAGs — confirmed)

- **Graphite**: "visualize the dependencies between all of your branches… view multiple stacks at once"; three stack visualizations; VS Code extension "visualize dependency graphs" — all at the **branch/PR** level — [Visualize a stack](https://graphite.dev/docs/visualize-stack), [stacked diffs guide](https://graphite.com/guides/stacked-diffs). No issue/ticket graph.
- **Aviator av**: open-source CLI; `av tree` "provides a clean visual of the entire stack and state of each branch" — [av-stack-tree manpage](https://docs.aviator.co/aviator-cli/manpages/av-tree-1), [aviator-co/av](https://github.com/aviator-co/av). Branch-level only.
- **ghstack** (Meta): commit-oriented stacked-PR submission, no visualization layer to speak of — referenced in the ecosystem comparison at [pullnotifier's guide](https://pullnotifier.com/tools/stacked-prs).
- **Confirmed**: this entire category renders DAGs of *changes*, never of *tickets*. Conceptually useful (their stack views are good UI prior art for compact DAG rendering with per-node CI/review state), functionally orthogonal.

---

## Conclusions

### 1. Closest existing tools and exactly what's missing

| Tool | Has | Missing vs. concept |
|---|---|---|
| [moul/depviz](https://github.com/moul/depviz) | Multi-repo GitHub aggregation, dependency graph web UI, open/closed state, ready/blocked queries | No kanban-bucket dimension in the graph; no PR nodes; no batch creation; own edge store instead of GitHub's native dependencies; niche |
| [beads](https://github.com/steveyegge/beads) + [bead-me-up-scotty](https://github.com/brendan-appstart/bead-me-up-scotty) / [beads-viewer](https://github.com/mgalpert/beads-viewer) | Agent-native DAG ticket model; web UIs with kanban AND graph; drag-to-link edges | Not GitHub issues (own tracker); single project; board and graph are separate tabs — the fusion is exactly what's absent |
| GitHub native ([dependencies](https://github.blog/changelog/2025-08-21-dependencies-on-issues/) + [Projects v2](https://docs.github.com/en/issues/planning-and-tracking-with-projects/managing-items-in-your-project/adding-items-to-your-project)) | All the data: cross-repo blocked-by edges, multi-repo/org issue+PR aggregation, full API/CLI/webhooks | Zero graph rendering — sidebar lists and a "Blocked" icon only |
| [ZenHub](https://www.zenhub.com/blog-posts/enhancements-to-roadmaps) | GitHub-native multi-repo, dependencies, arrows on roadmap | Epic-level timeline lines, not per-ticket DAG; board and dependency views separate |
| [Huly](https://docs.huly.io/integrations/github/) | Two-way multi-repo GitHub sync onto one board; blocked-by relations; batch-ish creation via sync | No graph rendering at all |

### 2. Novelty verdict
**Thin composition, genuinely unshipped.** Every subsystem exists with primary-source proof; the specific product — persistent per-project DAG whose nodes are GitHub issues/PRs colored and grouped by workflow bucket, across many repos, with batch creation, framed as human-attention allocation — does not. The strongest evidence it's worth building: (a) GitHub shipped the edge data model but explicitly did not ship the visualization ([roadmap #956 closed](https://github.com/github/roadmap/issues/956)); (b) the beads ecosystem independently reinvented the need four times in months and *still* nobody fused board+graph; (c) the session-manager layer keeps dying (Terragon, Vibe Kanban, Crystal, Height) while the planning/attention layer above it stays unserved. Risk to note: GitHub could ship a dependency-graph view in Projects at any time — the moat is the fused view + agent-workflow framing, not the plumbing.

### 3. What to reuse if building it
- **Data & edges**: GitHub GraphQL `blockedBy`/`blocking` fields and mutations + [REST issue-dependency endpoints](https://docs.github.com/en/rest/issues/issue-dependencies) + webhooks — store *nothing* except view state; GitHub is the SSOT for tickets, edges, and status. PR linkage via the timeline/`closedByPullRequestsReferences` and Projects item fields.
- **Batch creation**: [`gh issue create --blocked-by/--blocking`](https://github.blog/changelog/2026-06-10-manage-sub-issues-types-and-dependencies-from-github-cli/) or the GraphQL mutations — the existing `to-tickets` skill output maps 1:1 onto this.
- **Aggregation shortcut**: a Projects v2 org project already aggregates issues+PRs [from any repository/org](https://docs.github.com/en/issues/planning-and-tracking-with-projects/managing-items-in-your-project/adding-items-to-your-project) with a Status field — usable as the bucket store so the app needs no database.
- **DAG rendering**: React Flow + dagre/ELK auto-layout (React Flow is what [bead-me-up-scotty](https://github.com/brendan-appstart/bead-me-up-scotty) uses, incl. drag-node-to-node edge creation); mermaid flowcharts for a zero-effort static fallback, with [maxim-lobanov's action](https://github.com/maxim-lobanov/build-issue-dependencies-graph) as the status-color convention (green/yellow/white) to steal.
- **Reference implementations to read, not adopt**: [depviz](https://github.com/moul/depviz) for ready/blocked query semantics and multi-source sync; [Graphite's stack views](https://graphite.dev/docs/visualize-stack) for compact per-node CI/review-state UI.
- **The one real design problem** (where the novelty actually lives): a layout that keeps edges legible while nodes are constrained to status columns — i.e., a dagre layout with rank = workflow bucket instead of rank = topological depth. Nothing surveyed solves this; it's the piece to prototype first.
