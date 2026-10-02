#!/usr/bin/env bash
# Close the tracked "live-suite failing" issue on the next green run (issue #143).
#
# The self-healing half of the contract: once a run succeeds, the tracking
# issue (if any) is closed with a resolution comment, so the issue's own
# timeline reads as the outage window — opened at first failure, closed at
# first recovery. A green run with no open tracking issue is a no-op: the
# success path must never create anything.
#
# Environment (optional, provided by the workflow):
#   RUN_URL - the green run's URL (defaults to a local placeholder)
set -euo pipefail

LABEL="live-suite-failure"
RUN_URL="${RUN_URL:-}"
[ -n "$RUN_URL" ] || RUN_URL="(run link unavailable)"

existing="$(gh issue list --state open --label "$LABEL" --json number --jq '.[0].number' 2>/dev/null || true)"

if [ -n "$existing" ]; then
  gh issue close "$existing" \
    --comment "Recovered — the next scheduled live-suite run went green: ${RUN_URL}"
  echo "live-suite-notify: closed tracking issue #${existing}"
else
  echo "live-suite-notify: no open tracking issue; nothing to do"
fi
