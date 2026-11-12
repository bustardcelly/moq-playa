# Operator Runbook (Post-Merge, Ownership-Required Steps 5+)

This runbook starts after the current PR (Steps 1-4) is merged.

## Preconditions

- You are logged into npm with an account that has owner/publish rights for:
  - existing `@moqt/*` packages
  - existing `@playa/player`
  - new `@openmoq` org/packages
- Repo is on the post-merge commit and clean locally.
- CI workflow file for publishing is already present (`.github/workflows/publish.yml`).

## 5) Bootstrap-publish the new package names (manual one-time)

Goal: publish first versions for all new names so Trusted Publisher can manage them later.

1. Build and pack from the merged commit:

```sh
pnpm install
pnpm -r build
pnpm test
pnpm smoke:exports
mkdir -p release
pnpm --filter "./packages/*" pack --pack-destination "$PWD/release"
```

2. Verify tarballs contain the expected names:
- `@openmoq/browser`
- `@openmoq/loc`
- `@openmoq/locmaf`
- `@openmoq/msf`
- `@openmoq/playback`
- `@openmoq/player`
- `@openmoq/quic`
- `@openmoq/transport`
- `@openmoq/webtransport`
- `@openmoq/playa`

3. Publish each tarball once:

```sh
npm publish file:release/<tarball>.tgz --access public
```

Notes:
- This is the bootstrap publish for new names (typically at `0.5.9` as aligned in plan).
- Do not publish a new `@playa/player` package in this step.

## 6) Configure Trusted Publisher for each new npm package

For each of the ten `@openmoq/*` packages, configure npm Trusted Publisher to allow this repo workflow:

- Org/user: GitHub owner of repo
- Repository: repo name
- Workflow filename: `publish.yml`
- Environment: blank (unless workflow later adds one)
- Allowed action: `npm publish`

After setup, verify each package is visible via:

```sh
npm view @openmoq/<pkg> name
```

## 7) Cut first automated release tag after bootstrap

Goal: validate normal CI release path for renamed packages.

1. Bump to next release version (post-bootstrap), commit, and push.
2. Tag that version `vMAJOR.MINOR.PATCH`.
3. Push tag.

`publish.yml` should:
- validate versions,
- build/test/smoke,
- pack publishable packages,
- publish only versions not already present.

## 8) Move interop client pins to `@openmoq/*`

After `@openmoq/transport` and `@openmoq/webtransport` exist on npm:

1. Update:
- `tools/moq-interop-client/package.json`
  - `@moqt/transport` -> `@openmoq/transport`
  - `@moqt/webtransport` -> `@openmoq/webtransport`
2. Refresh lockfile:

```sh
cd tools/moq-interop-client
npm install --package-lock-only
```

3. Commit this change.

## 9) Deprecate old package names (one-time registry actions)

Run as an owner of old packages:

```sh
npm deprecate @moqt/browser "*" "@moqt/browser has moved. Install @openmoq/browser instead."
npm deprecate @moqt/loc "*" "@moqt/loc has moved. Install @openmoq/loc instead."
npm deprecate @moqt/locmaf "*" "@moqt/locmaf has moved. Install @openmoq/locmaf instead."
npm deprecate @moqt/msf "*" "@moqt/msf has moved. Install @openmoq/msf instead."
npm deprecate @moqt/playback "*" "@moqt/playback has moved. Install @openmoq/playback instead."
npm deprecate @moqt/player "*" "@moqt/player has moved. Install @openmoq/player instead."
npm deprecate @moqt/quic "*" "@moqt/quic has moved. Install @openmoq/quic instead."
npm deprecate @moqt/transport "*" "@moqt/transport has moved. Install @openmoq/transport instead."
npm deprecate @moqt/webtransport "*" "@moqt/webtransport has moved. Install @openmoq/webtransport instead."
npm deprecate @playa/player "*" "@playa/player has moved. Install @openmoq/playa instead."
```

Important:
- Deprecate only after replacements are installable.
- Keep ownership of `@moqt` and `@playa` orgs.

## 10) Final verification release

Cut one more standard version/tag release and verify:

- All ten `@openmoq/*` packages publish cleanly.
- `@playa/player` is deprecated (old path), `@openmoq/playa` is the live path.
- Interop client path and pins are consistent with new package namespace.

## Quick verification checklist

- `npm view @openmoq/<pkg> name` works for all ten packages.
- Installing any old name emits deprecation warning with correct replacement.
- `pnpm smoke:exports` passes in repo.
- Publish workflow succeeds for a fresh tag without manual intervention.
