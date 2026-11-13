# GitHub token broker

Standalone Fastify API for issuing short-lived GitHub installation tokens to agent pods. Platform design: [broker architecture](https://github.com/julie-ng/ai-native-sdlc/blob/main/architecture/reference/token-broker.md).

> [!NOTE]
> The token exchange contract and policy are implemented with injected dependencies. Real Kubernetes and GitHub adapters and their server wiring are separate work. No UI.

## Development

Node.js 24 LTS; `.node-version` and the package engine requirement select that release line. TypeScript ES modules and npm.

```sh
npm ci
npm run dev
```

The server listens on `127.0.0.1:3000`. Set `HOST` and `PORT` to override; a container deployment will need `HOST=0.0.0.0`.

- `npm run dev`: run TypeScript with the `tsx` file watcher.
- `npm run build`: compile the service into `dist/`.
- `npm start`: run the compiled service; run the build first.
- `npm run lint`: ESLint and TypeScript recommended checks.
- `npm run typecheck`: check service and test types without emitting files.
- `npm test`: build the service, then run mocked endpoint tests and process tests for address configuration and SIGINT/SIGTERM shutdown.
- `GET /healthz`: process liveness only; does not check Kubernetes, GitHub or Key Vault readiness.

`src/app.ts` constructs the application without opening a socket. `src/server.ts` defines `HOST`/`PORT` near the top, configures logging, starts the listener and handles shutdown. Production logging uses Fastify's Pino integration with authorization-header redaction.

Local imports use `.js` extensions so compiled ES modules run directly in Node. The build emits service code only; Vitest handles the TypeScript test files. No credentials are needed to run the bootstrap or tests. Container packaging and deployment belong to later broker work.

## Token exchange

`POST /v1/github-token` accepts `Authorization: Bearer <projected Kubernetes token>`. The body must be absent or an empty JSON object (`{}`). Any query string, extra body field, malformed body or unsupported content type returns `400`. Validation runs before Fastify's schema processing can strip properties or coerce input.

Success returns `200`, `Cache-Control: no-store`, and:

```json
{ "token": "<GitHub installation token>", "expiresAt": "2026-11-13T12:00:00Z" }
```

Both values come from the issuer; the broker does not calculate expiry. Errors contain only `{ "error": { "code": "..." } }`:

| HTTP | Code | Condition |
|---|---|---|
| 400 | `invalid_request` | Query string, extra fields or malformed input |
| 401 | `invalid_credential` | Missing/malformed bearer, failed token review or wrong audience |
| 403 | `assignment_denied` | Unapproved namespace/ServiceAccount, pod identity mismatch or missing/malformed/unapproved repository annotation |
| 503 | `dependency_unavailable` | Token review, pod lookup or token issuer throws; no fallback credential |

The validator authenticates the projected token and checks its audience before pod lookup or issuance. Only namespace `agents` and these ServiceAccounts are permitted:

| ServiceAccount | Issued permissions |
|---|---|
| `planner` | `contents: read`, `issues: read` |
| `coder` | `contents: write`, `pull_requests: write`, `issues: read` |

The looked-up pod's UID and ServiceAccount must match the reviewed token. Its `ai-native-sdlc/repository` annotation must be an `owner/repo` entry in the configured allowlist. The issuer receives that entry's explicit numeric `repositoryId` and `installationId`, plus the role's permissions. Caller-supplied scope is rejected. Upstream exceptions are neither logged nor included in responses.

### Dependency injection and tests

`buildApp(fastifyOptions, tokenExchangeOptions)` registers the endpoint when the second argument is supplied. `TokenExchangeOptions` in `src/token-exchange.types.ts` contains:

- `tokenValidator`: the `TokenValidator` function returning authentication/audience results and reviewed pod identity.
- `podLookup`: the `PodLookup` function returning UID, ServiceAccount and annotations for a namespace/pod name.
- `tokenIssuer`: the `TokenIssuer` function returning a scoped token and its expiry.
- `repositories`: an allowlist mapping `owner/repo` to `{ repositoryId, installationId }`.

The route plugin is explicitly registered from `src/routes/v1/github-token.post.ts`. Directories and the `.post.ts` suffix describe the URL and method; Fastify's route declaration implements them, without an autoload dependency.

`src/server.ts` still calls `buildApp` without adapters, so `npm start` exposes only `/healthz`. Real adapters, allowlist environment parsing and server wiring are outside [issue #6](https://github.com/julie-ng/ai-native-sdlc-github-broker/issues/6). Run/step/attempt labels and production hardening are also deferred.

Run `npm run lint`, `npm run typecheck` and `npm test` on Node 24. `test/routes/v1/github-token.post.test.ts` uses Fastify `inject()` and mocked dependencies to verify the contract, exact issuance scope, call order, authorization denials and sanitized dependency failures. It needs no network, cluster, key or credentials. The existing `test/app.test.ts` process tests require permission to bind a loopback socket.

## Decision log

| Date | Decision | Reasoning |
|---|---|---|
| 2026-11-13 | Adopt the platform-services ESLint formatting rules in `eslint.config.mjs` | Keep formatting consistent across services. Retain this Fastify service's TypeScript base; the source config's Nuxt wrapper and JSDoc rules for absent `server/utils` and `server/db` directories do not apply here. |
| 2026-11-13 | Implement the issue #6 MVP with injected functions and a server-side repository allowlist | Keep policy testable offline; real adapters and server wiring belong to separate issues. |
| 2026-11-13 | Use the planner/coder permissions above and omit run/step/attempt labels | Planner reads and clones; coder opens its own PR. Workflow traceability waits for the workflow service. Approved in the implementation plan. |
| 2026-11-13 | Explicitly register route plugins under `src/routes/<version>/<resource>.<method>.ts` | Make URL and method visible in filenames while retaining native Fastify registration without autoload. |
| 2026-10-25 | Bootstrap a standalone Fastify application | Broker has no UI and remains separate from workflow/artifact services. |
| 2026-10-25 | Use TypeScript ES modules, Node 24 LTS and Vitest | Architect's PR review supersedes the initial JavaScript, Node 22 and Node test-runner defaults. |
| 2026-10-25 | Compile for production; use `tsx` for development | Type-check explicitly and test the compiled process that production will run. |
