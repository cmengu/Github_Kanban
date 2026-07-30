# Overviewer

A web app that answers one question across every project at once: **where does my attention go next?**

It aggregates GitHub issues and pull requests across many repos, batch-creates tickets, and renders each project as a dependency DAG whose nodes migrate through workflow buckets — tickets → in progress → in review → done — **without the graph ever dissolving into plain columns**. Kanban shows status; a graph shows structure; this fuses both so a single glance reads "that PR in review gates two downstream tickets — review it now, let the agents run everywhere else."

Built for the wayfinder → spec → tickets → AI-agents-implement → human-reviews loop, where planning is front-loaded and execution should run freely.

## Why it doesn't exist yet

The prior-art sweep ([docs/ticket-dag-viewer-landscape-2026-07-29.md](docs/ticket-dag-viewer-landscape-2026-07-29.md)) found every ingredient shipped, and the fusion unshipped:

- **GitHub owns all the data** — cross-repo issue dependencies (GA Aug 2025), full GraphQL/REST/CLI, multi-repo Projects v2 — and renders none of it as a graph.
- **beads** and its four community viewers prove the demand, but all keep board and graph as separate tabs, on a non-GitHub tracker.
- PM tools (Linear, Jira, ZenHub, Plane, Huly) draw dependency *lines on timelines*, never a live board-fused DAG.

## Architecture stance

**Store nothing.** GitHub is the single source of truth for tickets, edges (native blocked-by), and buckets (Projects v2 Status field with its PR automations). The app is a stateless lens: GraphQL in, React Flow + dagre out. The one genuinely novel problem — prototype it first — is a layout with **rank = workflow bucket** instead of rank = topological depth.

## Status

Spec and tickets live on this repo's [issue tracker](https://github.com/cmengu/Meta-Harness/issues). This repo's own issue DAG is the first dataset the Overviewer will render.
