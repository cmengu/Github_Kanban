#!/usr/bin/env bash
# Re-records snapshot.json from live GitHub.
#
# The fixture is evidence, not imagination (step 2, decision 2) — so the query
# that produced it is checked in beside it and this is the only way the file is
# ever written. Hand-editing snapshot.json defeats the entire point.
#
# Needs `gh auth login`. Run from the repo root:
#     bash src/fixtures/payloads/record.sh
#
# The one transformation applied to the response: GraphQL returns
# `{ data: { repository: {...} } }` for a single repo, and the app's `Snapshot`
# holds a list of repos, so the repository object is lifted into `{ repos: [...] }`.
# Nothing inside it is touched. Add a repo by querying again and appending.

set -euo pipefail

OWNER="${1:-cmengu}"
NAME="${2:-Github_Kanban}"
OUT="$(dirname "$0")/snapshot.json"

read -r -d '' QUERY <<'GRAPHQL' || true
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
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
    }
  }
}
GRAPHQL

gh api graphql -f query="$QUERY" -F owner="$OWNER" -F name="$NAME" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin)["data"]["repository"]; print(json.dumps({"repos":[d]}, indent=2, ensure_ascii=False))' \
  > "$OUT"

python3 -c '
import json, sys
repo = json.load(open(sys.argv[1]))["repos"][0]
issues = repo["issues"]["nodes"]
edges = sum(len(i["blockedBy"]["nodes"]) for i in issues)
pulls = repo["pullRequests"]["nodes"]
print("recorded %s: %d issues, %d blocked-by relations, %d pull requests"
      % (repo["nameWithOwner"], len(issues), edges, len(pulls)))
' "$OUT"
