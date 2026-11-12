# Migration Progress Update (Steps 1-4 Complete)

This PR covers the repository-side scope migration work that can be completed without npm ownership actions.
It intentionally stops after Step 4 from `_migration/moqt_to_openmoq_STEPS.md`.

## What this PR completes

1. Prepared for migration ownership (Step 1 context)
- Confirmed this branch is aligned to migrate package scope to `@openmoq`.
- Kept migration tracking notes in `_migration/moqt_to_openmoq_STEPS.md` up to date.

2. Renamed published package scope references in-repo (Step 2)
- Updated public package names and import/dependency specifiers from:
  - `@moqt/*` -> `@openmoq/*`
  - `@playa/player` -> `@openmoq/playa`
- Applied changes across package manifests, source imports, tests, examples, docs, and workflow-related script references.
- Updated alias/config surfaces (`vitest`, `vite`, smoke/export validation paths) to the new scope/package names.
- Preserved private workspace package identities (`@moqt/examples`, `@moqt/example-node-publisher`, `@moqt/example-node-relay`, `@moqt/media-conformance-runner`) while updating their dependencies/imports as needed.

3. Updated interop Docker overlay paths (Step 3)
- Updated `tools/moq-interop-client/Dockerfile.client` to overlay locally built packages under:
  - `node_modules/@openmoq/transport`
  - `node_modules/@openmoq/webtransport`
  - `node_modules/@openmoq/quic`
- Preserved required build order: transport -> webtransport -> quic.
- Intentionally kept `tools/moq-interop-client/package.json` pins at:
  - `@moqt/transport@0.5.7`
  - `@moqt/webtransport@0.5.7`
  so `npm ci` remains resolvable before npm bootstrap publication.
- Confirmed `publish-interop-client.yml` already rebuilds on pushes to `main`.

4. Regenerated and validated repo state (Step 4)
- Regenerated package READMEs from manifest metadata.
- Ran install/build/test/smoke validation to verify migration consistency.
- Confirmed no lingering old public scope references in normal code paths (excluding intentional migration notes and interop pin exceptions above).

## Validation executed

- `pnpm install`
- `pnpm -r build`
- `pnpm test`
- `pnpm smoke:exports` (passing after rename updates)
- Lint/diagnostic checks on changed surfaces (no new issues introduced in reviewed paths)

## Deferred work (requires npm package/org ownership after merge)

The remaining migration steps are intentionally not in this PR because they require npm owner permissions and registry operations:

- Manual bootstrap publish of new `@openmoq/*` package names.
- Trusted Publisher setup per package in npm.
- Deprecation of old `@moqt/*` and `@playa/player` names with migration messaging.
- Post-bootstrap interop pin transition from `@moqt/*` to `@openmoq/*`.
- Follow-up release/tag flow once registry state is prepared.
