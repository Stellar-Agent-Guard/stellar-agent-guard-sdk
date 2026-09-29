<!--
Release notes template — issue #154.

Manual path, chosen over release-drafter. Copy this file's body into the GitHub
Release editor at tag time; the headings are what make two releases look alike
to a reader, not the prose under them.

Why manual, and not a drafter action: no PR in this repository carries a
label, so label-driven categorisation would draft an empty release, and the
repo pins no action SHAs, so adopting a drafter would be the one workflow
introducing a different pinning discipline. Both are recorded on issue #154.

Sections are the standard Keep a Changelog set. Keep every heading, including
the empty ones, and write "None." under a heading that has nothing in it — a
missing section is indistinguishable from a forgotten one, and this is the
package's only published history until issue #6 decides the changelog question.

The type labels match the commit types CONTRIBUTING.md documents as in use:
`feat`, `fix`, `docs`, `chore`, `ci`, `test`.
-->

## What's Changed

<!-- One line, imperative, no "this release". What a user would notice. -->

## Added

<!-- New public API, new capability. Reference the PR or issue, e.g. (#194).
     Breaking additions go in Added with a **BREAKING** marker, not here alone. -->

## Changed

<!-- Behaviour that existing callers can observe and may have to act on:
     changed defaults, widened scope of an event, new required options.
     State the before → after, not just the after. -->

## Deprecated

<!-- Still supported, scheduled for removal, with the version and the
     replacement named. Say "no deprecations in this release" when empty. -->

## Removed

<!-- Deleted or newly-refused behaviour. Name what callers must stop using. -->

## Fixed

<!-- Bugs a user could hit. Prefer the symptom over the root cause. -->

## Security

<!-- Vulnerability disclosures only. Say the section is empty unless it is not;
     a silently-empty Security section reads as a clean bill of health. -->

## Upgrade Notes

<!-- Anything a user must DO: migration steps, config keys to add, values to
     change. Delete this section only if there is genuinely nothing — and
     prefer writing "No action required." over deleting it. -->

<!--
Checklist before publishing:

- [ ] `package.json` `version` equals the tag without its `v` — publish.yml
      fails the run otherwise, deliberately.
- [ ] The `npm publish` run for this tag is green.
- [ ] Every entry above cites a PR or issue number, or is traceable to one.
- [ ] The "Current published version" header in docs/publishing-history.md has
      been bumped to this version.
-->
