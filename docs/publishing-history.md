# Publishing History & Process Reconciliation

**Current published version:** `0.1.1` — the version declared in
[`package.json`](../package.json) and the one the README status paragraph points
at. This file records how the publish pipeline got here; it is not the source of
truth for what is live.

Verify the version actually on the registry:

```bash
npm view stellar-agent-guard-sdk version
```

Release notes for what has actually shipped live in [`CHANGELOG.md`](../CHANGELOG.md)
(Keep a Changelog format). This file is the historical annex for publish-pipeline
archaeology — how the pipeline got to a version, not what a version contains.

## Release 0.1.0 (Manual Publish Deviation)

`stellar-agent-guard-sdk@0.1.0` was published directly to the npm registry by the maintainer to unblock initial package availability. Because it was published directly outside the tag-triggered GitHub Actions workflow (`.github/workflows/publish.yml`), no corresponding release tag or `publish` workflow run exists for `0.1.0`. This is a known, one-time historical deviation, not the intended release process.

## Release 0.1.1+ (Standard Automated Pipeline)

Subsequent releases, starting with `0.1.1`, are produced through the automated pipeline:
1. Version bump in `package.json`.
2. Git release tag (`v*.*.*`) pushed to `main`.
3. Execution of `.github/workflows/publish.yml` on GitHub Actions using the maintainer `NPM_TOKEN`.
4. Create the GitHub Release for that tag, and paste a body built from
   [`.github/RELEASE_TEMPLATE.md`](../.github/RELEASE_TEMPLATE.md), filling every section.
5. Read the finished body back against the tag: the version it names must be the version
   that is live, and every entry must trace to a merged PR or an issue.

Steps 4 and 5 are manual by choice, not an oversight — see
[Release notes](#release-notes) below. They run *after* the publish run rather than
before it: the notes describe what actually shipped, so they are written once the
`npm publish` run for that tag is green, and they name the version that is live rather
than the one that was intended. Step 5 exists because a release body written from memory
is how a note about `0.1.2` ends up attached to the `v0.1.3` tag.

## Release notes

The GitHub Release body is written by hand from a template. A drafter action was
considered and rejected (issue #154): no PR in this repository carries a label, so
label-driven categorisation would draft an empty release every run, and no workflow here
pins an action by SHA, so a drafter would be the single workflow introducing a different
pinning discipline. Conventional-commit discipline is real in this repo and is what the
template's sections are keyed to, but with no tags and no GitHub Releases yet there is no
draft history for automation to learn from.

The template uses the standard [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
sections and the commit types `CONTRIBUTING.md` documents as in use — `feat`, `fix`,
`docs`, `chore`, `ci`, `test` — so the mapping from a merged PR to a release section is
the mapping from its type. Keep the headings even when a section is empty and write
"None." under it: a missing section cannot be told from a forgotten one. The release
body is the per-tag record; [`CHANGELOG.md`](../CHANGELOG.md) is the cross-version
record (issue #6 decided "yes", executed in issue #81) — both are drafted from the
same commits and must not disagree.
