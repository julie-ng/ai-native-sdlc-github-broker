# GitHub token broker

Standalone Fastify API for issuing short-lived GitHub installation tokens to agent pods. Platform design: [broker architecture](https://github.com/julie-ng/ai-native-sdlc/blob/main/architecture/reference/token-broker.md).

> [!NOTE]
> The token exchange contract and policy are implemented with injected dependencies. The server wires GitHub and Kubernetes adapters from startup environment configuration. No UI.

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

## API reference site

Published URL: <https://julie-ng.github.io/ai-native-sdlc-github-broker/>. Publication requires the docs workflow to deploy after merge; live availability is not yet verified. The human developer must first set repository **Settings → Pages → Source: GitHub Actions**.

```sh
npm ci
npm ci --prefix docs-site
npm run docs:build
npm run docs:dev
```

`docs:build` generates the ignored `docs-site/openapi.json` from the Fastify route schemas with stub dependencies, then builds the default Starlight site into `docs-site/dist/`. `docs:dev` also regenerates the spec before starting Astro at <http://localhost:4000/ai-native-sdlc-github-broker/>; restart it after route-schema changes. No network, cluster, GitHub key or token is needed to generate the spec. Swagger is a development dependency used only by the generation script; the running broker exposes no docs or OpenAPI route.

Route schemas must have `summary` and `description`; keep their tags, request/response schemas and examples aligned with behavior. Before a PR, run `npm run lint`, `npm run typecheck`, `npm test` and `npm run docs:build`. The docs workflow builds on pull requests without deploying, and deploys on pushes to `main` or manual dispatch on `main`. See [docs-site/README.md](docs-site/README.md) for the generation details.

`src/app.ts` constructs the application without opening a socket. `src/server.ts` defines `HOST`/`PORT` near the top, configures logging, starts the listener and handles shutdown. Production logging uses Fastify's Pino integration with authorization-header redaction.

Local imports use `.js` extensions so compiled ES modules run directly in Node. The build emits service code only; Vitest handles the TypeScript test files. Tests generate disposable RSA keys and use no real credentials or network dependencies. Running the server requires the configuration below.

## Token exchange

`POST /v1/github-token` accepts `Authorization: Bearer <projected Kubernetes token>`. The body must be absent or an empty JSON object (`{}`). Any query string, extra body field, malformed body or unsupported content type returns `400`. Validation runs before Fastify's schema processing can strip properties or coerce input.

Send no body without a JSON content type, or send `{}` as JSON. An empty body with `Content-Type: application/json` returns `400 invalid_request` from Fastify's JSON parser.

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

`src/server.ts` validates configuration and supplies both adapters and the repository allowlist to `buildApp`, exposing `/healthz` and `/v1/github-token`. Run/step/attempt labels and production hardening are also deferred.

Run `npm run lint`, `npm run typecheck` and `npm test` on Node 24. `test/routes/v1/github-token.post.test.ts` uses Fastify `inject()` and mocked dependencies to verify the contract, exact issuance scope, call order, authorization denials and sanitized dependency failures. It needs no network, cluster, key or credentials. The existing `test/app.test.ts` process tests require permission to bind a loopback socket.

## Kubernetes adapters

`createKubernetesAdapters()` in `src/kubernetes-adapters.ts` implements `TokenValidator` with `POST /apis/authentication.k8s.io/v1/tokenreviews` and `PodLookup` with `GET /api/v1/namespaces/{namespace}/pods/{podName}`. It uses the broker's mounted ServiceAccount token, explicit `token-broker` audience, 30-second timeouts and rejected redirects. Failed authentication (including `status.error`) returns an unauthenticated result; API/transport failures throw a sanitized `KubernetesDependencyError` for the endpoint's `503` response.

The broker ServiceAccount needs cluster-wide `tokenreviews: create` in API group `authentication.k8s.io` and core `pods: get` in namespace `agents`. Configure `KUBERNETES_API_URL` and `KUBERNETES_SERVICE_ACCOUNT_TOKEN_PATH` to override the default in-cluster API and mounted token path. Set `NODE_EXTRA_CA_CERTS=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt` before starting Node to trust the cluster CA. See the [Kubernetes adapter guide](docs-site/src/content/docs/kubernetes-adapters.md) for configuration and error semantics. Infrastructure owns the RBAC; deployment manifests are in `manifests/`.

## GitHub issuer adapter

`createGitHubTokenIssuer()` in `src/github-token-issuer.ts` reads `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH` at startup and returns a `TokenIssuer`. It loads the mounted RSA PEM once, converting PKCS#1 to PKCS#8 in memory. Every GitHub token request sends exactly one `repository_ids` entry and the explicit role `permissions`; installation tokens are never cached. GitHub's expiry is returned unchanged, and failures become sanitized `GitHubTokenIssuerError` instances. Startup errors identify missing/invalid configuration, unreadable files, invalid keys and non-RSA keys using fixed messages; issuance errors stay generic. The server constructs the issuer at startup; no upstream request is made until token issuance.

See the [issuer guide](docs-site/src/content/docs/github-issuer.md) for configuration, request details and offline verification. The docs site includes the guide under “GitHub token issuer”.

## Configuration and deployment

| Variable | Requirement / default |
|---|---|
| GITHUB_APP_ID | Required numeric App ID |
| GITHUB_APP_PRIVATE_KEY_PATH | Required readable RSA PEM file path |
| GITHUB_REPOSITORIES | Required nonempty JSON object, e.g. `{"example/repo":{"repositoryId":123,"installationId":456}}`; IDs must be positive safe integers |
| KUBERNETES_API_URL | HTTPS origin; defaults to `https://kubernetes.default.svc` |
| KUBERNETES_SERVICE_ACCOUNT_TOKEN_PATH | Defaults to `/var/run/secrets/kubernetes.io/serviceaccount/token` |
| NODE_EXTRA_CA_CERTS | Set before Node starts; in cluster, `/var/run/secrets/kubernetes.io/serviceaccount/ca.crt` |
| HOST / PORT | `127.0.0.1` / `3000`; container sets HOST to `0.0.0.0` |

Invalid configuration exits before listening with fixed diagnostics that omit supplied values. Startup reads the App key but does not contact GitHub or Kubernetes. Kubernetes token reads happen per request; the default ServiceAccount token automount must remain enabled. Node loads CA trust at process startup.

Build locally with `docker build -t github-broker:local .`. Supply configuration using `docker run --env-file <local-env-file> --mount type=bind,src=<absolute-key-file>,dst=/mnt/app.pem,readonly -e GITHUB_APP_PRIVATE_KEY_PATH=/mnt/app.pem -p 3000:3000 github-broker:local`. The image uses the pinned platform-services Node 24 base, production dependencies and the non-root node user. The Docker context allows only build inputs.

GitHub Actions verifies pull requests and branch pushes. After checks pass on a push to main, the production environment publishes `<acr>.azurecr.io/github-broker:latest` and `sha-<full-commit>`. Configure production environment variable `AZURE_ACR_NAME` and secrets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID` for Azure OIDC, following platform-services. The first real publication happens after merge.

Infrastructure must provide namespace github-broker, ServiceAccount token-broker with workload identity, RBAC for TokenReview and pod lookup, ACR pull access, and SecretProviderClass github-broker-secrets exposing token-broker-gh-app-private-key. This change does not deploy infrastructure or run the live pod exchange test.

```sh
cp manifests/.env.example manifests/.env
# Edit manifests/.env with real names and IDs (gitignored).
set -a
. manifests/.env
set +a
envsubst '$AZURE_ACR_NAME $GITHUB_APP_ID $GITHUB_REPOSITORIES' < manifests/deployment.yaml | kubectl apply -f -
kubectl apply -f manifests/service.yaml
kubectl -n github-broker rollout status deployment/github-broker
kubectl -n github-broker get pods
kubectl -n github-broker logs deployment/github-broker
```

The in-cluster URL is http://github-broker.github-broker.svc.cluster.local. The readiness probe uses /healthz, which checks the process only. To inspect it locally, run `kubectl -n github-broker port-forward service/github-broker 3000:80` and `curl http://127.0.0.1:3000/healthz`. After publishing a new latest image, use `kubectl -n github-broker rollout restart deployment/github-broker`.

## Decision log

| Date | Decision | Reasoning |
|---|---|---|
| 2026-11-13 | Wire startup adapters and ship a container, CI publication and plain envsubst manifests (#14) | Preserve Kubernetes defaults, reject empty allowlists, and fail before listening with fixed diagnostics. Infrastructure and human-run live tests remain separate. |
| 2026-11-13 | Implement Kubernetes adapters with native fetch, startup-configured CA trust and per-call reads of the broker token file | Keep the two-call MVP dependency-free and observe projected-token updates without caching credentials. As clarified in [#8](https://github.com/julie-ng/ai-native-sdlc-github-broker/issues/8#issuecomment-6853981045), nonempty TokenReview status.error means unauthenticated (401); transport/HTTP failures remain dependency errors (503). |
| 2026-11-13 | Generate an API reference with Swagger 9, Astro and the default Starlight theme, per [#10](https://github.com/julie-ng/ai-native-sdlc-github-broker/issues/10) | Swagger 9 supports Fastify 5. Reuse the reference repo's pinned Astro/Starlight/OpenAPI renderer versions; omit its TypeDoc, Tailwind and component overrides. Keep generation offline and out of the broker runtime. |
| 2026-11-13 | Use `@octokit/auth-app` for App JWT signing and Node fetch for each installation-token request | Avoid hand-written signing and bypass the library's installation-token cache; each issuance sends explicit repository and permission scope. PKCS#1 keys are normalized to PKCS#8 in memory at startup. |
| 2026-11-13 | Adopt the platform-services ESLint formatting rules in `eslint.config.mjs` | Keep formatting consistent across services. Retain this Fastify service's TypeScript base; the source config's Nuxt wrapper and JSDoc rules for absent `server/utils` and `server/db` directories do not apply here. |
| 2026-11-13 | Implement the issue #6 MVP with injected functions and a server-side repository allowlist | Keep policy testable offline; real adapters and server wiring belong to separate issues. |
| 2026-11-13 | Implement the proposed permissions: planner `contents: read`, `issues: read`; coder `contents: write`, `pull_requests: write`, `issues: read`; no run, step or attempt labels | Planner reads and clones; coder opens its own PR. Workflow traceability waits for the workflow service. Proposed in [#6](https://github.com/julie-ng/ai-native-sdlc-github-broker/issues/6) and discussed with the human developer at a high level on 2026-11-13; not reviewed in detail. Open for confirmation in the [PR #9 review](https://github.com/julie-ng/ai-native-sdlc-github-broker/pull/9). |
| 2026-11-13 | Explicitly register route plugins under `src/routes/<version>/<resource>.<method>.ts` | Make URL and method visible in filenames while retaining native Fastify registration without autoload. Discussed with the human developer at a high level on 2026-11-13; not reviewed in detail. Keep this convention as requested in the [PR #9 review](https://github.com/julie-ng/ai-native-sdlc-github-broker/pull/9#discussion_r4563085759). |
| 2026-10-25 | Bootstrap a standalone Fastify application | Broker has no UI and remains separate from workflow/artifact services. |
| 2026-10-25 | Use TypeScript ES modules, Node 24 LTS and Vitest | Architect's PR review supersedes the initial JavaScript, Node 22 and Node test-runner defaults. |
| 2026-10-25 | Compile for production; use `tsx` for development | Type-check explicitly and test the compiled process that production will run. |
