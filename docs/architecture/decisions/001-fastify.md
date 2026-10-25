# ADR-001: Standalone GitHub broker with Fastify

- **Status:** Accepted — bootstrap in separate PR; broker exchange not implemented
- **Date:** 2026-10-25

## Context

The GitHub token broker has its own repository and deployment, separate from the workflow/artifact services. It has no UI. Nuxt remains the intended framework for platform services with a future UI; the broker needs a small HTTP API.

## Decision

Use **Fastify**, with TypeScript ES modules on Node 24 LTS and Vitest for tests. The architect selected Fastify after comparing it with Express and has used it more recently. TypeScript, Node 24 and Vitest follow the bootstrap PR review.

- Integrated Pino logging, enabled explicitly, and built-in HTTP injection support reduce setup work.
- Route schemas and lifecycle hooks are available when needed; Kubernetes authentication and scope policy remain application code.
- Keep the application factory separate from the listening process so handlers can be tested without binding a port.

Sources: [logging](https://fastify.dev/docs/latest/Reference/Logging/), [testing](https://fastify.dev/docs/latest/Guides/Testing/), [validation](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/).

## Alternatives and trade-offs

| Alternative | Assessment |
|---|---|
| Express | Sufficient for the API and a smaller initial framework API; logging, validation and HTTP test tooling require more assembly. Less recent architect familiarity. |
| Nuxt | Appropriate for the separate platform-services application and eventual UI; broker does not need that application structure. |

Fastify adds lifecycle/plugin conventions to learn. Its default validation uses JSON Schema; whether to integrate Zod is still open. Performance was not benchmarked for this broker and is not the deciding factor.

## Verification

Framework capabilities checked against primary documentation. Bootstrap validation belongs to its separate PR; Kubernetes caller validation and GitHub issuance have no runtime evidence yet. See the [implementation plan](../../plans/github-token-broker.md).

## Decision log

| Date | Decision | Reasoning |
|---|---|---|
| 2026-10-25 | Separate broker repository; no UI | Preserve independent deployment and keep Nuxt for workflow/artifact services and their future UI. |
| 2026-10-25 | Select Fastify over Express | Useful API facilities and more recent architect familiarity. |
| 2026-10-25 | Adopt TypeScript, Node 24 LTS and Vitest | Architect's bootstrap review replaces the initial JavaScript, Node 22 and Node test-runner defaults. |
