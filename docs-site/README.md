# Broker API reference

Default [Starlight](https://starlight.astro.build/) theme with [starlight-openapi](https://starlight-openapi.vercel.app/getting-started/). Astro `7.4.4`, Starlight `0.42.8` and starlight-openapi `0.27.0` match the [platform-services reference package](https://github.com/julie-ng/ai-native-sdlc-platform-services/blob/main/docs-site/package.json). This is an independent npm package and lockfile; it has no TypeDoc, Tailwind, theme overrides or route middleware.

From the repository root on Node 24:

```sh
npm ci
npm ci --prefix docs-site
npm run docs:build
npm run docs:dev
```

- `docs:build` runs `scripts/generate-openapi.ts` and then Astro, producing `docs-site/dist/`.
- `docs:dev` regenerates the spec and starts Astro at <http://localhost:4000/ai-native-sdlc-github-broker/>. Restart after route-schema changes.
- `npm run preview --prefix docs-site` serves the built site for inspection.

The generator registers `@fastify/swagger` 9 before calling the same `registerAppRoutes` function as `buildApp`. Swagger's [compatibility table](https://github.com/fastify/fastify-swagger#compatibility) lists Fastify 5 support for version 9. Stub adapters throw if invoked; generation reads schemas without opening a socket or contacting Kubernetes/GitHub. It calls `ready()`, writes `app.swagger()` to ignored `docs-site/openapi.json`, and closes the app. Neither the spec nor build output is committed. No Swagger plugin or docs route is added to the running broker.

The token route's existing `preValidation` remains authoritative. Its documentation body schema describes `{}`, while its route-level validator compiler avoids AJV's mandatory-body behavior and preserves the existing absent-body contract. Swagger 9 also assumes body schemas are mandatory, so the generation script corrects that single OpenAPI `requestBody.required` flag. Response examples include every stable error code. Edit the actual route schemas, not the generated JSON; schemas must include `summary` and `description`. Run the root lint, typecheck, tests and `docs:build` before a PR.

The [docs workflow](../.github/workflows/docs.yml) builds on PRs without deploying. Pushes to `main` and manual dispatch on `main` build and deploy to <https://julie-ng.github.io/ai-native-sdlc-github-broker/>. The human developer must enable **Settings → Pages → Source: GitHub Actions** once, and check the live site after merge; local builds do not verify publication. `site` and `base` in `astro.config.mjs` match that URL.

Starlight may report an empty `i18n` collection or missing custom `404` entry during a successful build. This site uses no translations or custom 404 page.
