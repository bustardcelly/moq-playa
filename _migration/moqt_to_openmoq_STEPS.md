# moqt to openmoq steps

Rename the nine published `@moqt/*` packages to `@openmoq/*`, and rename `@playa/player` to `@openmoq/playa`. Leave the private package names (`@moqt/examples`, `@moqt/example-node-publisher`, `@moqt/example-node-relay`, `@moqt/media-conformance-runner`) unchanged. Their dependency specifiers still have to change, because they import the renamed libraries.

1. **COMPLETE/TA** Create the `@openmoq` organization on npmjs.com and confirm you are an owner of the existing `@moqt/*` packages and of `@playa/player`. Ownership of those packages is what lets you deprecate them later. Keep the `@moqt` and `@playa` npm orgs after the rename so the old names cannot be re-registered.

2. **COMPLETE/TA** In one repo change, rename these packages and every specifier that points at them:

   | Current | New |
   |---|---|
   | `@moqt/browser` | `@openmoq/browser` |
   | `@moqt/loc` | `@openmoq/loc` |
   | `@moqt/locmaf` | `@openmoq/locmaf` |
   | `@moqt/msf` | `@openmoq/msf` |
   | `@moqt/playback` | `@openmoq/playback` |
   | `@moqt/player` | `@openmoq/player` |
   | `@moqt/quic` | `@openmoq/quic` |
   | `@moqt/transport` | `@openmoq/transport` |
   | `@moqt/webtransport` | `@openmoq/webtransport` |
   | `@playa/player` | `@openmoq/playa` |

   `@playa/player` becomes `@openmoq/playa`, not `@openmoq/player`, because that name is the renamed `@moqt/player`. The `packages/playa` directory stays. Update `name` and dependency fields in every workspace `package.json`, including the renamed playa package and the four private packages. Update `description` fields that still say `@moqt/...` or `@playa/player`, because `scripts/generate-package-readmes.mjs` copies those onto the npm page. Update import specifiers, the aliases in `vitest.config.ts` and `examples/vite.config.ts`, and `scripts/smoke-exports.mjs` (the import strings and the `node_modules/@openmoq` directory it creates). Drop the `node_modules/@playa` directory and the `@playa/player` smoke import; `@openmoq/playa` lives under `@openmoq`. Update the root README and the docs that tell people what to install, and add the old-name to new-name note in that same README change. That note includes `@playa/player` → `@openmoq/playa`.

3. **TA** In that same change, point `tools/moq-interop-client/Dockerfile.client` at `node_modules/@openmoq/{transport,webtransport,quic}`. Keep the existing build order: compile `transport` and copy it into `node_modules` before compiling `webtransport`, then `quic`. Leave `tools/moq-interop-client/package.json` pinned at `@moqt/transport@0.5.7` and `@moqt/webtransport@0.5.7` for now, so `npm ci` in that image still resolves. `publish-interop-client.yml` rebuilds this image on every push to `main`.

4. **TA?** Regenerate the package READMEs with `node scripts/generate-package-readmes.mjs --write`, then run `pnpm install`, `pnpm -r build`, `pnpm test`, and `pnpm smoke:exports`. Merge this only when those pass.

5. **RAY** From that commit, pack the ten renamed packages and publish each once by hand as a member of the npm org: `npm publish --access public` of the real `@openmoq/*@0.5.9` tarballs, including `@openmoq/playa@0.5.9`. Do not publish a new version of the old name `@playa/player`. That package stays on npm as `@playa/player@0.5.9` until it is deprecated. `@openmoq/playa@0.5.9` is a new package, so this version can ship with dependencies on `@openmoq/*`.

6. **TA** On each of the ten new npm packages, including `@openmoq/playa`, add this repo's `publish.yml` as a trusted publisher, using the same OIDC settings the workflow comments already describe.

7. **RAY** Bump to the next version and push that tag. That tag is the first CI publish of the ten `@openmoq/*` packages, including `@openmoq/playa`. A `v0.5.9` tag publishes nothing new, because `publish.yml` skips versions already on npm.

8. **RAY** After step 5, change the interop client's pins from `@moqt/transport@0.5.7` and `@moqt/webtransport@0.5.7` to the `@openmoq` versions now on npm, and refresh `tools/moq-interop-client/package-lock.json`. Doing this earlier makes `npm ci` fail the image build.

9. **RAY** After step 5, deprecate the nine old `@moqt/*` packages and `@playa/player`:

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

   Run these while logged in as an owner of the `@moqt` packages and of `@playa/player`. Deprecate only after step 5, so every warning points at a package that can be installed. Installing the old names still succeeds and prints the warning. Installing `@openmoq/playa` does not. Keep ownership of the `@moqt` and `@playa` npm orgs so those names cannot be re-registered.

10. **RAY** Bump version and tag to confirm the npm release process publishes the ten `@openmoq/*` packages, including `@openmoq/playa`.
