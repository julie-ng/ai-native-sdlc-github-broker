# GitHub token broker

Standalone Fastify API for issuing short-lived GitHub installation tokens to agent pods. Platform design: [broker architecture](https://github.com/julie-ng/ai-native-sdlc/blob/main/architecture/reference/token-broker.md).

> [!NOTE]
> Bootstrap only. TokenReview, authorization policy and GitHub token issuance are not implemented. No UI.

## Development

Node.js 22.13+; `.node-version` selects the 22 LTS line. JavaScript ES modules and npm.

```sh
npm ci
npm run dev
```

The server listens on `127.0.0.1:3000`. Set `HOST` and `PORT` to override; a container deployment will need `HOST=0.0.0.0`.

- `npm start`: run without the file watcher.
- `npm run lint`: ESLint recommended checks.
- `npm test`: process tests for address configuration and SIGINT/SIGTERM shutdown.
- `GET /healthz`: process liveness only; does not check Kubernetes, GitHub or Key Vault readiness.

`src/app.js` constructs the application without opening a socket. `src/server.js` configures logging, starts the listener and handles shutdown. Production logging uses Fastify's Pino integration with authorization-header redaction.

No compilation step is required. No credentials are needed to run the bootstrap or tests. Container packaging and deployment belong to later broker work.

## Decision log

| Date | Decision | Reasoning |
|---|---|---|
| 2026-10-25 | Bootstrap a standalone Fastify application | Broker has no UI and remains separate from workflow/artifact services. |
| 2026-10-25 | Use JavaScript ES modules, npm and Node 22 as initial defaults | Match the architect's JavaScript preference and the available development runtime. |
| 2026-10-25 | Use the Node test runner initially | Exercise startup/shutdown without adding a test-framework dependency. |
