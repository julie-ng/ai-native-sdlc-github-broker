---
title: GitHub token issuer
description: Startup configuration and scope of the GitHub App token issuer adapter.
---

The GitHub issuer implements the broker's injected `TokenIssuer` function. It is available as `createGitHubTokenIssuer` in `src/github-token-issuer.ts`; the server constructs it at startup from environment configuration and wires `/v1/github-token`.

## Startup configuration

Call `await createGitHubTokenIssuer()` once at startup, then pass the returned function as `tokenIssuer` in the token exchange dependencies. The factory reads:

| Environment variable | Value |
|---|---|
| `GITHUB_APP_ID` | Numeric GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY_PATH` | Path to the mounted private PEM key file |

The factory reads the key once and keeps it in memory. GitHub's RSA PKCS#1 PEM is accepted: Node's `createPrivateKey` parses it and exports PKCS#8 in memory for `@octokit/auth-app`. No manual conversion or key copy is required. Reloading a changed key requires restarting the broker. The adapter does not access Key Vault; provisioning the mounted file belongs to deployment.

## GitHub request

For every issuance, `@octokit/auth-app` signs an RS256 App JWT. The issuer sends `POST https://api.github.com/app/installations/{installationId}/access_tokens` with the JWT as bearer authentication and both explicit scope fields:

```json
{
  "repository_ids": [123456],
  "permissions": { "contents": "read", "issues": "read" }
}
```

The example uses the planner's permissions. The endpoint policy supplies the approved repository and installation IDs and role permissions; the HTTP caller cannot choose them. Coder permissions are `contents: write`, `issues: read`, `pull_requests: write`.

The adapter uses only Octokit's App JWT API, bypassing its installation-token cache entirely. Node's built-in `fetch` sends a fresh token request for every issuance, including repeated or concurrent assignments. It returns `{ token, expiresAt }`, copying `expires_at` from GitHub without calculating an expiry.

Startup failures throw `GitHubTokenIssuerError` with a fixed reason: `GITHUB_APP_ID missing or not numeric`, `GITHUB_APP_PRIVATE_KEY_PATH missing`, `Private key file unreadable`, `Private key is invalid`, or `Private key is not RSA`. No configuration values, file paths, key contents or original causes are included. Network and GitHub response failures keep the generic `GitHub token issuance unavailable` message without upstream body, headers, credentials or cause. The issuer logs nothing. The existing endpoint maps issuer failures to `503 dependency_unavailable`; its public schema does not change.

## Verification and limits

`npm run lint`, `npm run typecheck` and `npm test` run on Node 24. Issuer tests generate a throwaway RSA key, mock all GitHub calls, verify JWT signatures and claims, assert exact request scopes, and exercise cache isolation and sanitized failures. They need no real key or network.

A live GitHub check is a separate, human-run proof. Retries, token caching, metrics and key rotation are outside the MVP scope. Server wiring and deployment instructions are in the repository README.
