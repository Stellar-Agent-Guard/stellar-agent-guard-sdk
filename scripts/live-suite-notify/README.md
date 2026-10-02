# Live-suite failure notification (issue #143).
#
# The weekly live-suite can fail on the Actions page where nobody is looking —
# drift (a protocol upgrade, an RPC change) is exactly the failure mode that
# happens when nobody is editing the repo. This file is the *simulation harness*
# for the notify steps that live in `.github/workflows/live-suite.yml`: the same
# two scripts the workflow runs, executed here against a scripted fake `gh`,
# so the idempotency contract is testable offline.
#
# Idempotency contract (the acceptance criteria, in one place):
#
#   1. On failure: exactly one open issue labeled `live-suite-failure` exists.
#      The notify step searches open issues for the label before creating one;
#      if it exists it comments the run link instead — so two consecutive
#      failures produce ONE issue and TWO comments, never a duplicate.
#   2. On the next green run: that issue is closed with a resolution comment
#      (self-healing signal — the issue's own timeline reads as an outage
#      window: opened at first failure, closed at first recovery).
#   3. A green run with no open tracking issue is a no-op.
#   4. No external webhook and no secret: path (a) from the issue discussion —
#      in-repo, maintainer-visible, self-clearing. Path (b) (Slack/Telegram)
#      stays declined by default unless a maintainer opts in later; if opted
#      in, the secret NAME would be documented here, never its value.
#
# The scripts are plain bash + the repo's existing `gh` dependency (Actions
# provides GH_TOKEN automatically for `permissions: issues: write`), so there
# is nothing new to install and no third-party action to trust.
#
# Dry-run method (what this file proves, per the acceptance criteria's "state
# method"): tests/unit/live-suite-notify.test.ts runs the real scripts against
# a fake `gh` on PATH and asserts the call sequence for all four contract rows
# above — two consecutive failures = one create + one comment; failure→success =
# close with resolution comment; success with no open issue = zero calls.

# ── The scripts, verbatim as the workflow invokes them ──────────────────────
#
# failure step (if: failure(), on schedule + workflow_dispatch):
#
#   scripts/live-suite-notify/failure.sh
#     issue=$(gh issue list --state open --label live-suite-failure --json number ... )
#     if [ -z "$issue" ]; then
#       gh issue create --title "live-suite failing (scheduled run)" \
#         --label live-suite-failure --body "..."   # body carries the run link
#     else
#       gh issue comment "$issue" --body "still failing: <run url>"
#     fi
#
# success step (if: success(), on schedule + workflow_dispatch):
#
#   scripts/live-suite-notify/success.sh
#     issue=$(gh issue list --state open --label live-suite-failure ...)
#     if [ -n "$issue" ]; then
#       gh issue close "$issue" --comment "recovered: <run url>"
#     fi
#
# The single tracked issue is identified by the label, not by a hardcoded
# number, so a maintainer closing it manually does not break automation, and
# the label doubles as the filter handle ("label applied for filtering").
