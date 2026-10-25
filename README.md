# GitHub token broker

Standalone Fastify API for issuing short-lived GitHub installation tokens to agent pods. Platform design: [broker architecture](https://github.com/julie-ng/ai-native-sdlc/blob/main/architecture/reference/token-broker.md).

> [!NOTE]
> Bootstrap only. TokenReview, authorization policy and GitHub token issuance are not implemented. No UI.

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
- `npm test`: build the service, then run Vitest process tests for address configuration and SIGINT/SIGTERM shutdown.
- `GET /healthz`: process liveness only; does not check Kubernetes, GitHub or Key Vault readiness.

`src/app.ts` constructs the application without opening a socket. `src/server.ts` defines `HOST`/`PORT` near the top, configures logging, starts the listener and handles shutdown. Production logging uses Fastify's Pino integration with authorization-header redaction.

Local imports use `.js` extensions so compiled ES modules run directly in Node. The build emits service code only; Vitest handles the TypeScript test files. No credentials are needed to run the bootstrap or tests. Container packaging and deployment belong to later broker work.

## Decision log

| Date | Decision | Reasoning |
|---|---|---|
| 2026-10-25 | Bootstrap a standalone Fastify application | Broker has no UI and remains separate from workflow/artifact services. |
| 2026-10-25 | Use TypeScript ES modules, Node 24 LTS and Vitest | Architect's PR review supersedes the initial JavaScript, Node 22 and Node test-runner defaults. |
| 2026-10-25 | Compile for production; use `tsx` for development | Type-check explicitly and test the compiled process that production will run. |
