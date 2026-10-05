#!/usr/bin/env bash
# Open-or-update the single tracked "live-suite failing" issue (issue #143).
#
# Idempotency contract (see README.md in this directory):
#   - no open issue labeled `live-suite-failure` → create ONE, body carries the
#     run link (and the trigger kind, so a manual dispatch failure reads
#     differently from a scheduled one);
#   - an open issue already exists → comment the run link on it instead.
# Either way, N consecutive failures leave exactly one open issue and N-1
# "still failing" comments after the first.
#
# Environment (both optional, both provided by the workflow):
#   RUN_URL   - the failing run's URL (defaults to a local placeholder)
#   TRIGGER   - `schedule` or `workflow_dispatch` (informational, into the body)
set -euo pipefail

LABEL="live-suite-failure"
RUN_URL="${RUN_URL:-}"
TRIGGER="${TRIGGER:-unknown}"
[ -n "$RUN_URL" ] || RUN_URL="(run link unavailable)"

# The single tracked issue is found by label, not by a pinned number: closing it
# manually never breaks automation, and the next failure just opens a fresh one.
existing="$(gh issue list --state open --label "$LABEL" --json number --jq '.[0].number' 2>/dev/null || true)"

if [ -n "$existing" ]; then
  gh issue comment "$existing" \
    --body "Still failing — another scheduled live-suite run failed: ${RUN_URL}"
  echo "live-suite-notify: commented on existing tracking issue #${existing}"
else
  gh issue create \
    --title "live-suite failing (scheduled testnet run)" \
    --label "$LABEL" \
    --body "$(cat <<EOF
The scheduled live-suite run failed. Drift — a protocol upgrade, an RPC change, an expired testnet fixture — is exactly what this suite exists to catch when nobody is editing the repo.

- Failed run: ${RUN_URL}
- Trigger: \`${TRIGGER}\`
- Re-run locally with \`npm run test:integration\` (needs \`.env.phase2\`).

This issue is maintained by the \`live-suite\` workflow: it stays open (gaining one comment per consecutive failure) until a run goes green, at which point it is closed automatically with the recovery run linked. Closing it manually is always safe — the next failure opens a fresh one.
EOF
)"
  echo "live-suite-notify: created tracking issue (label ${LABEL})"
fi
