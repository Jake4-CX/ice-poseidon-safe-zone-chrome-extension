---
name: release
description: Prepare a SafeZone+ release - bump the version, write the release notes and the in-extension update note, test, and commit. Use when the user asks to release, ship, publish or cut a new version of the extension.
---

# Releasing SafeZone+

Publishing is automated: `.github/workflows/release.yml` runs when `version.json` changes on
`main`. It typechecks, tests, builds `release/safezone-plus-v<version>.zip` and creates the
GitHub release `v<version>` with `docs/release-notes/v<version>.md` as its description. Installed
copies poll `version.json` on `main` and show an update notice.

So a release is: **the right files in one commit on `main`.** Your job is to prepare that commit.

## Steps

1. **Pick the version.** Read the latest tag (`git tag --sort=-v:refname | head -1`, or the
   current `version` in `extension/manifest.json` if it was never released). Patch (0.2.0 → 0.2.1)
   for fixes, minor (0.2.x → 0.3.0) for new features. Ask the user if unsure.
2. **Bump** `version` in both `extension/manifest.json` and `package.json`.
3. **Run `npm run package:ext`.** It builds the zip locally and syncs `version.json` (version +
   today's date). The zip is not committed (`release/` is gitignored); CI builds its own.
4. **Write `version.json` → `notes`:** one sentence (max 300 chars), shown inside the extension's
   update notice. Plain language for viewers, no markdown.
5. **Write `docs/release-notes/v<version>.md`:** the GitHub release description. Audience:
   players and viewers, most not developers. Look at previous files in `docs/release-notes/` for
   the shape:
   - `## Fixed` / `## New` sections with short bold lead-ins, describing what users notice, not
     internals. Summarise from `git log <last-tag>..HEAD` and the diff.
   - `## Update` with the zip name and the replace-folder-then-↻ steps, plus new-install steps.
   - The unofficial-fan-project footer.
6. **Verify:** `npm run typecheck` and `npm test` pass. All three versions (manifest,
   package.json, version.json) match and the notes file exists. CI fails the release otherwise.
7. **Commit** with message `release: v<version>` (code changes for the release may go in
   separate commits before it). End the message with the attribution trailer.
8. **Don't push unless the user asks.** Pushing `version.json` to `main` is what publishes the
   release and announces it to every installed copy. Tell the user that's what pushing will do.

## Gotchas

- Never commit a `version.json` change without the matching notes file and version bumps, or
  the workflow fails (nothing is published, but nothing is announced either).
- If a release must be redone, delete the GitHub release and tag first; the workflow skips
  versions that already have a release. Re-run it from the Actions tab (workflow_dispatch).
- In tests, always pass a message to `assert.ok`: a failing bare `assert.ok(x)` makes Node
  re-parse the tsx-compiled file and hangs the run.
