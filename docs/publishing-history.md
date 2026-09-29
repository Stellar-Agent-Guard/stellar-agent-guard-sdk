# Publishing History & Process Reconciliation

**Current published version:** `0.1.1` — the version declared in
[`package.json`](../package.json) and the one the README status paragraph points
at. This file records how the publish pipeline got here; it is not the source of
truth for what is live.

Verify the version actually on the registry:

```bash
npm view stellar-agent-guard-sdk version
```

There is no `CHANGELOG.md` in this repository yet, so there is no changelog to
link to. When one lands, this header should point at it as the current release
notes and this file becomes the historical annex for publish-pipeline
archaeology.

## Release 0.1.0 (Manual Publish Deviation)

`stellar-agent-guard-sdk@0.1.0` was published directly to the npm registry by the maintainer to unblock initial package availability. Because it was published directly outside the tag-triggered GitHub Actions workflow (`.github/workflows/publish.yml`), no corresponding release tag or `publish` workflow run exists for `0.1.0`. This is a known, one-time historical deviation, not the intended release process.

## Release 0.1.1+ (Standard Automated Pipeline)

Subsequent releases, starting with `0.1.1`, are produced through the automated pipeline:
1. Version bump in `package.json`.
2. Git release tag (`v*.*.*`) pushed to `main`.
3. Execution of `.github/workflows/publish.yml` on GitHub Actions using the maintainer `NPM_TOKEN`.
