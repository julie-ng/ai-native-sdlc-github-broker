---
title: Kubernetes adapters
description: TokenReview and pod lookup configuration, permissions and failure behavior.
---

`createKubernetesAdapters()` in `src/kubernetes-adapters.ts` returns the injected `tokenValidator` and `podLookup` functions. Both use Node's built-in `fetch`; no Kubernetes client library is needed. Server wiring remains separate work, so `npm start` still exposes only `/healthz`.

## Configuration

| Setting | Default | Purpose |
|---|---|---|
| `KUBERNETES_API_URL` | `https://kubernetes.default.svc` | Kubernetes API origin; must be HTTPS without credentials, a path prefix, query or fragment |
| `KUBERNETES_SERVICE_ACCOUNT_TOKEN_PATH` | `/var/run/secrets/kubernetes.io/serviceaccount/token` | Broker's own mounted ServiceAccount token file |
| `NODE_EXTRA_CA_CERTS` | Set explicitly before Node starts | Cluster CA file; use `/var/run/secrets/kubernetes.io/serviceaccount/ca.crt` in cluster |

The adapter configuration can be passed to the factory instead of read from the environment. CA trust is process configuration, not a factory option: Node reads `NODE_EXTRA_CA_CERTS` only at process startup. For example, when the adapters are wired into the server:

```sh
NODE_EXTRA_CA_CERTS=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt npm start
```

Use a test CA file via `NODE_EXTRA_CA_CERTS` when testing against a local HTTPS server. Unit tests stub `fetch` and use a temporary broker-token file; they need no cluster or CA. TLS verification is never disabled. The broker token file is read for each API call so updates to the mounted projected token are observed without an adapter-side credential cache.

## API calls and RBAC

- `POST /apis/authentication.k8s.io/v1/tokenreviews` sends the caller's token in `spec.token` and `spec.audiences: ["token-broker"]`. Only the broker's own token goes in the Authorization header.
- `GET /api/v1/namespaces/{namespace}/pods/{podName}` reads the reviewed pod's UID, ServiceAccount and annotations. A missing annotation map becomes `{}`; the existing endpoint policy denies missing repository assignments.

Both calls reject redirects and use a 30-second request timeout, including response-body reading. The broker's `token-broker` ServiceAccount in namespace `github-broker` needs `create` on `tokenreviews` in API group `authentication.k8s.io` cluster-wide and `get` on core `pods` in namespace `agents`. It needs neither list/watch access nor access to Kubernetes Secrets. RBAC manifests and deployment configuration are outside this adapter issue.

## Results and failures

Authentication succeeds only when `status.authenticated` is `true`, `status.error` is absent or empty, `status.audiences` contains `token-broker`, and the ServiceAccount username and single-valued pod-name/pod-UID extras are well formed. Other successful review responses, including missing/malformed fields or JSON and nonempty `status.error`, return `{ authenticated: false, audienceMatches: false }`; the endpoint responds with `401 invalid_credential`. No error text or token is included in that result. This follows the [issue #8 clarification](https://github.com/julie-ng/ai-native-sdlc-github-broker/issues/8#issuecomment-6853981045).

Transport errors, timeouts, redirects, unreadable/empty broker credentials and unexpected HTTP statuses throw `KubernetesDependencyError` with the fixed message `Kubernetes dependency unavailable`. Expected statuses are `201` for TokenReview and `200` for pod lookup. Unexpected statuses include `401`/`403` on the broker's own API request, pod `404` and Kubernetes `5xx`. Malformed pod responses also throw this error. The existing endpoint maps it to `503 dependency_unavailable`.

The adapters log nothing and include no response body, headers, token or original cause in dependency errors. The HTTP contract and policy remain unchanged. Tests verify adapter behavior and endpoint error mapping offline. Confirming real cluster responses remains a separate live proof; no live Kubernetes call is part of this implementation.
