# GitHub token broker — implementation plan

> [!NOTE]
> Draft for review, 2026-10-25. Fastify bootstrap merged in [PR #1](https://github.com/julie-ng/ai-native-sdlc-github-broker/pull/1). Caller validation and GitHub issuance are not implemented. Setup and contract defaults below are proposals for review, not provisioned resources.

## Scope and design references

Build the standalone GitHub token broker as the first platform service, using TypeScript and Fastify on Node 24 LTS, with Vitest for tests. It has its own repository/deployment and no UI. Prove pod authentication and repository/role-scoped GitHub access, then evaluate reuse for artifact authentication. [Framework decision](../architecture/decisions/001-fastify.md).

- [Broker architecture](https://github.com/julie-ng/ai-native-sdlc/blob/main/architecture/reference/token-broker.md): credential flow and trust model.
- [ADR-003](https://github.com/julie-ng/ai-native-sdlc/blob/main/architecture/decisions/003-platform-services-vs-agent-pods.md): trusted services versus untrusted agent pods.
- [ADR-012](https://github.com/julie-ng/ai-native-sdlc/blob/main/architecture/decisions/012-agent-identity-commits-vs-github-tokens.md): short-lived, per-step GitHub access.
- [ADR-014](https://github.com/julie-ng/ai-native-sdlc/blob/main/architecture/decisions/014-commit-signing.md): native Git and separate role GPG keys; signing is independent of the broker.

Service code and its tests belong in this repository. Build plans live in `docs/plans/`; broker-specific ADRs live in `docs/architecture/decisions/`. Platform-wide decisions remain in the parent architecture repository. Cluster identity/RBAC changes belong in the infrastructure repository; Argo templates belong in the workflows repository. The architect applies Azure/cluster changes and reports runtime results.

## Tomorrow: preparation and first implementation

- **Architect:** follow the [App setup guide](#github-app-setup--architect), starting tomorrow. No App creation or key provisioning is part of this documentation change.
- **Implementation:** review the [proposed contract](#proposed-broker-contract), then begin the [first coding task](#first-coding-task--offline-exchange-and-policy-tests). This task needs no App, credentials or cluster access.
- **Before live testing:** inspect deployed RBAC/workload identity and agree the broker's key-loading path. Infrastructure state is not verified by this plan.

### GitHub App setup — architect

<details>
<summary>One-time setup checklist and official instructions</summary>

1. Create two disposable **private** repositories, A and B, under the account that will own the installation. Initialize each with a README so it has an existing commit to push to a test branch. Record their full `owner/repository` names.
2. Follow [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app). Open the human developer's Settings → Developer settings → GitHub Apps → New GitHub App. Proposed settings:

| Setting | Value for this proof |
|---|---|
| Owner | Human developer's account; App administration is privileged. |
| Name | Choose an available, distinct broker name; availability is not checked here. |
| Homepage | Broker repository URL. |
| User authorization / device flow | Leave disabled; use installation access, not user access tokens. Leave callback/setup URLs empty. |
| Webhooks | Deselect **Active**; this broker does not need inbound webhooks. |
| Repository permissions | **Contents**, **Issues**, **Pull requests**: Read & write, the existing role-policy union. Retain required Metadata read access; other permissions stay at No access. |
| Installation availability | Proposed: **Only on this account**, assuming A and B belong to the human owner. Other owners would require revisiting visibility. |

The installation grants the App's ceiling; each issued token must still specify its narrower repository and role permissions. Add no ruleset bypass for the App.

3. Follow [Installing your own GitHub App](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app). Choose **Only select repositories** and select A and B. Both must be installed so a failed cross-repository write tests token downscoping, not merely a missing installation.
4. Follow [Managing private keys](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps): open the App's Credentials → Key pairs → New key; retain the downloaded PEM outside the checkout. Never paste it into this document or a PR. Record the App ID from the App settings. The installation ID can be resolved during integration using the documented App-authenticated repository-installation lookup in the [token issuance guide](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).
5. Before the cluster proof, prepare the agreed Key Vault delivery path. Proposed first implementation: store the PEM as a **Key Vault secret**, have the broker read it using its workload identity at startup and retain it in memory. No vault request per agent exchange. Rotation initially means updating the secret and restarting the broker. This is local JWT signing after secret retrieval, distinct from a remote signing service.

**Handoff:** App ID, App settings link, installed repository names/IDs, installation ID once resolved, and vault/secret identifiers. These identify configuration; the private key stays in the secret store. The implementation prepares configuration/manifests; the architect provisions the resources and verifies the broker identity can read the secret.

**Ready for live integration when:** A/B exist and are installed, the App has the required permission ceiling, and the broker can load its key. Exact vault identifiers, deployed permissions and key retrieval are still unverified. None blocks the offline task below.

</details>

### Proposed broker contract

These names and HTTP details are implementation proposals. Review them before writing the endpoint; platform-wide run/step semantics remain governed by the workflow design.

**Request:** `POST /v1/github-token`, with `Authorization: Bearer <projected Kubernetes token>`. No query parameters; body absent or `{}`. Reject extra fields such as repository, role, installation ID or permissions with `400`; do not silently strip overrides. Fastify's default Ajv configuration removes some extra properties, so configure rejection explicitly and test it. [Validation behavior](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/#validator-compiler).

**Successful response:** `200`, `Cache-Control: no-store`, JSON `{ "token": "<installation token>", "expiresAt": "<ISO 8601 timestamp>" }`. Expiry comes from GitHub's response, not a newly calculated local lifetime.

**Trusted caller context:** TokenReview requests/checks audience `token-broker`, validates the expected `agents` namespace and ServiceAccount, then resolves the bound pod. Match pod UID and ServiceAccount against the API object. Role derives from that identity, never from a role field in the request or a freely chosen label.

Proposed assignment metadata, set by trusted test manifests initially:

| Pod field | Caller-context value | Validation |
|---|---|---|
| Label `ai-native-sdlc/run-id` | `runId` | Platform run UUID, independent of Argo UID. |
| Label `ai-native-sdlc/step-key` | `stepKey` | Non-empty logical key, e.g. `C1` or `R1`; distinct from a database step UUID. |
| Label `ai-native-sdlc/attempt-number` | `attemptNumber` | Positive integer, initially `1`; distinct from an attempt UUID. |
| Annotation `ai-native-sdlc/repository` | `repository` | Exact allowlisted `owner/repository`; broker configuration resolves numeric repository and installation IDs. |

Pod identity comes from TokenReview/API data, not those labels. Missing/malformed assignments deny issuance. The label prefix and one-based attempt convention need alignment with workflow templates before Argo integration; retry substitution into metadata has not been verified. [Workflow contract discussion](https://github.com/julie-ng/ai-native-sdlc-workflows/pull/1).

Initial policy follows ADR-012; proposed ServiceAccount names must be checked against deployed infrastructure:

| ServiceAccount in `agents` | GitHub permissions |
|---|---|
| `planner` | `contents: read`, `issues: write` |
| `coder` | `contents: write` |
| `reviewer` | `contents: read`, `pull_requests: write` |
| `open-pr` | `pull_requests: write` |

Exercise coder/reviewer contents permissions first; later steps prove issue/PR operations. Unknown ServiceAccounts, including an unmapped `architect`, deny issuance. Role naming changes require an explicit policy update. Repository configuration must supply **one** numeric repository ID and its allowed installation; the issuer always receives explicit `repository_ids` and `permissions`. Request metadata cannot choose them.

Errors use `{ "error": { "code": "<stable code>" } }`; never return upstream credential-bearing request/response objects.

| HTTP | Code | Condition |
|---|---|---|
| 400 | `invalid_request` | Unsupported query/body fields or malformed input. |
| 401 | `invalid_credential` | Missing/malformed bearer token, unauthenticated TokenReview or wrong audience. |
| 403 | `assignment_denied` | Unexpected identity, missing/unapproved assignment, or pod UID/ServiceAccount mismatch. |
| 503 | `dependency_unavailable` | Kubernetes/GitHub unavailable; no credential fallback. |

Authenticate before resolving scope or invoking the issuer. TokenReview, pod lookup and issuance are separate injected dependencies. This preserves the distinction between caller identity, authorization policy and the capability being issued.

### First coding task — offline exchange and policy tests

**Deliverable:** the proposed endpoint wired to caller validation and policy selection, verified through Fastify `inject()` with mocked TokenReview, pod lookup and GitHub issuer. Runtime adapters remain separate; test issuers must not become a production fallback.

1. Define typed caller context and interfaces for those three dependencies; validate assignments and resolve repository/installation from explicit server configuration.
2. Implement the route, error mapping and no-store response. Keep authentication/policy helpers independent of HTTP and GitHub so their pattern can later support artifact endpoints.
3. Add deterministic Vitest cases before introducing live credentials:

| Case | Acceptance evidence |
|---|---|
| Valid reviewer/coder in repo A | Mock issuer receives exactly repo A's ID and the role's permissions; success contains the mock token/expiry and no-store header. |
| Missing token, failed TokenReview, wrong audience | Expected error; pod lookup/issuer are not called after failed authentication. |
| Pod UID/ServiceAccount mismatch; unknown namespace/role | Denied; issuer is never called. |
| Missing or malformed run/step/attempt/repository metadata | Denied; issuer is never called. |
| Assigned repository is outside broker configuration | Denied; no substitution with another installed repository. |
| Caller supplies repository/role/permission overrides | `400`; issuer is never called and input is not silently normalized away. |
| Kubernetes or issuer fails | Sanitized `503`; no token in the response or logs. |

**Done when:** clean install, lint, type checking and `npm test` pass on Node 24. New endpoint tests use injection/mocks; the suite needs no external services, App/key or cluster. Keep the passing bootstrap process tests, which use loopback HTTP. Record this as offline policy/HTTP evidence only; the real allowed/denied GitHub operations in step 4 remain necessary.

## Steps

### 0. Fastify bootstrap — complete

Merged 2026-10-25 in [PR #1](https://github.com/julie-ng/ai-native-sdlc-github-broker/pull/1): application factory, server entry point, health endpoint, logging, npm lockfile, lint, TypeScript build/type checking and Vitest process tests. No Kubernetes, GitHub or Azure credentials needed.

**Evidence:** clean install, lint, type checking, build, both startup/shutdown tests and the development smoke check passed on Node 24.22.1 before merge. This establishes the service foundation, not broker authentication or issuance.

### 1. Set the initial permission and assignment contract

- First exercise reviewer contents-read and coder contents-write using the proposed policy table above. Add operation tests for issue comments, review comments and PR creation after the basic exchange works.
- Confirm the intended GitHub App, human owner, installation and selected repositories. Use disposable private repositories A and B; install the App on both so the test can distinguish token downscoping from installation restrictions.
- Record the trusted assignment fields: workflow run UUID, logical step key, attempt number, repository and ServiceAccount. A run contains multiple step/attempt pods; a pod is not the whole run.
- For the first proof, trusted test manifests supply assignments and broker configuration lists permitted repositories/installations. This avoids requiring a workflow service or database before the broker can be tested.
- Use TypeScript ES modules and Fastify. Select maintained Kubernetes/GitHub clients when implementing their integration; the bootstrap does not need those dependencies.

**Ready to build when:** test operations, expected grants/denials, assignment fields and App setup responsibilities are explicit. Architect/coder naming in ADR-014 still needs reconciliation with planner/coder/reviewer/open-PR permissions; do not silently give a new role write access.

### 2. Implement Kubernetes caller validation and scope selection

One exchange endpoint accepts the pod's projected bearer token. The caller does not choose the repository, role, installation or GitHub permissions.

1. Submit the credential to Kubernetes `TokenReview`, explicitly requesting audience `token-broker`; require authenticated status and a matching returned audience.
2. Resolve the expected namespace, ServiceAccount and bound pod name/UID from the validated identity. Read that pod from the Kubernetes API and match its UID and ServiceAccount.
3. Read the trusted assignment, select the server-side role policy and resolve its permitted repository/installation.
4. Produce an internal caller context for the issuer: pod UID, run, step/attempt, role and repository.

Keep caller validation separate from GitHub issuance so another service can reuse the pattern. Reject missing/invalid credentials, unexpected identities, missing assignments and mismatches. Kubernetes lookup failures must not result in credentials. Test caller-supplied overrides cannot broaden scope.

Metadata is trusted only because agents cannot change it or create substitute workloads. Token possession authenticates the bearer; this is not additional proof of the physical source of an HTTP request.

**Go/no-go:** tests with representative Kubernetes responses cover those failures and expected caller contexts. Live pod validation follows in step 4; confirm the target cluster returns the required pod identity there. [TokenReview API](https://kubernetes.io/docs/reference/kubernetes-api/definitions/token-review-v1-authentication/), [bound-token validation](https://kubernetes.io/docs/reference/access-authn-authz/service-accounts-admin/).

### 3. Add GitHub token issuance and the service package

- Load the App private key only in the trusted broker. The accepted Azure design uses broker workload identity to read Key Vault; choose the loading/rotation mechanism before deployment. Do not create vault entries for individual agent tokens.
- Mint an installation token with both the assigned repository and explicit role permissions. Omitting either restriction can inherit wider installation grants. Return the token and expiry; keep credentials out of logs.
- Use a maintained App-auth library. Check its token caching behavior against per-step issuance; do not accidentally share a cached installation token across assignments.
- Package the service image, health checks and internal endpoint. Choose credential transport protection before the live exchange; public ingress is unnecessary for this proof.
- Prepare broker Kubernetes permissions: cluster-scoped `tokenreviews: create`, plus `pods: get` in `agents`. Azure workload identity for Key Vault is a separate permission path. Agents need neither Azure identity nor Secret-read/workload-creation permissions.

**Go/no-go:** issuer tests prove repository/permission restrictions are always supplied, errors return no token, and the deployment requirements are reviewable without cluster-admin privileges. Real GitHub scope enforcement is tested next. [GitHub issuance and expiry](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).

### 4. Prove allowed and denied operations from ordinary test pods

Deploy the broker in `github-broker`; run deterministic test commands in `agents` before introducing Argo or a model.

- Disable ordinary ServiceAccount-token automount. Project a dedicated token with audience `token-broker` at a constant file path. Kubelet supplies and rotates it; no per-pod HMAC Secret or Key Vault request is needed for this credential.
- Have the client read that file for each exchange. Supply the returned GitHub token to Git/`gh` through an ephemeral credential path; do not store it in image layers, remote URLs or workflow parameters.
- Verify the following with the same broker-issued credentials, recording expected versus actual results.

| Check | Required result |
|---|---|
| Read-role token reads private repo A through Git/API | Succeeds |
| Write-role token uses native Git to push a disposable branch in A | Succeeds |
| Read-role token attempts the same write | Denied |
| Token scoped to A attempts a write in B, also installed for the App | Denied |
| Invalid/wrong-audience token or unassigned pod requests access | Denied by broker |
| Caller tries repository/role overrides | Cannot broaden issued access |
| Kubernetes/GitHub dependency failure | No credential issued; useful error without secrets |

Push an existing commit to a new branch for the initial proof, keeping access testing independent of commit signing. Public reads do not establish repository isolation. Installation tokens support Git over HTTPS with Contents permission. [Installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation).

**Go/no-go:** every intended success and denial has runtime evidence. A successful token response alone is insufficient. Record partial successes; an integration failure does not erase a passing caller-validation layer.

### 5. Check credential lifecycle and failure recovery

- Observe projected-token rotation; confirm the client rereads the file and can exchange again. Set the requested lifetime deliberately and record actual cluster behavior. [Token projection and rotation](https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/#serviceaccount-token-volume-projection).
- Check replacement/retry pods get distinct validated pod contexts. Test a deleted pod's credential is rejected according to Kubernetes deletion/invalidation behavior, rather than assuming instant invalidation.
- Check expired GitHub credentials are replaced through a new exchange, and broker/GitHub outages produce bounded retries rather than an uncontrolled request loop.
- Record non-secret run/step/pod identifiers, issuance scope and expiry so failures can be traced. Clean up test branches/resources and test credentials after the proof.

**Go/no-go:** renewal and rejection behavior are recorded separately for the two credential types. GitHub tokens expire after one hour and remain reusable within scope until expiry/revocation; deleting a pod does not automatically revoke an already-issued GitHub token. Tokens are not inherently bound to a workflow run or branch. Repository rulesets remain separate controls.

### 6. Integrate a minimal Argo workflow, then a real committing role

- Run two deterministic steps with different ServiceAccounts and trusted assignments. Confirm their permission differences survive the Argo path.
- Add a retry/attempt and verify its identifiers and pod UID. Settle how logical steps and attempts map to Argo execution metadata.
- Inspect actual mounts and permissions, including any Argo executor credential. Do not assume executor permissions are absent from the model-driven container without checking.
- Once this works, test a real coder using broker access alongside separately delivered role GPG keys and Git identity configuration. Cloud signing-key delivery remains separate work under ADR-014.

**Go/no-go:** Argo produces the same allowed/denied results as direct pods; credentials stay out of Workflow parameters and logs. Signed-commit verification is a separate acceptance check before a real coding run. Argo failure does not invalidate the earlier direct-pod proof.

### 7. Evaluate artifact-service authentication

| Broker learning | Artifact-service application |
|---|---|
| Validated pod/run/step context | Candidate reusable authentication code |
| Server-side repository/role policy | Explicit artifact/action grants for the caller's step/attempt |
| Scoped GitHub token issuance | Scoped Blob SAS issuance |
| Separate Kubernetes and GitHub lifetimes | Separate Kubernetes and SAS lifetimes |

Use the results to compare Kubernetes-native validation with HMAC minting, mounting and cleanup. Decide whether reuse reduces work and dependencies before changing ADR-003/005. Role or run membership alone must not grant access to every artifact: check the specific producer step, attempt, artifact reference and action.

HMAC remains the documented artifact authentication mechanism until that decision. Either choice preserves the accepted transport: the artifact service authorizes requests and issues URLs; pods transfer bytes directly to/from Blob Storage.

## Decisions still needed

- Actual App registration/installation values and Kubernetes/GitHub client libraries.
- Review the proposed endpoint/metadata contract and reconcile it with deployed ServiceAccounts and workflow metadata; trusted assignment admission after test manifests remains open.
- Confirm startup key retrieval/rotation proposal, credential transport and client token handling before live tests.
- Operational defaults: timeouts/retries, issuance caching policy, readiness and availability.
- Architect/coder permission alignment and signing-key delivery before real coding runs.

## Verification status

2026-10-25: bootstrap merged with local validation recorded in step 0. Plan checked against accepted platform ADRs, workflow schema discussion and linked primary Kubernetes/GitHub/Fastify documentation. App configuration, cluster permissions and the broker exchange remain untested. Setup/contract additions are proposals; this documentation update creates no resources and runs no broker integration.

## Decision log

| Date | Decision / proposal | Reasoning |
|---|---|---|
| 2026-10-25 | Add App setup guide, proposed exchange contract and first offline task | Make the next coding session actionable while human App setup proceeds separately. |
| 2026-10-25 | Propose startup Key Vault secret retrieval and restart-based key reload | Avoid per-exchange vault traffic; delivery remains to verify before cluster testing. |
| 2026-10-25 | Propose explicit rejection of caller overrides and typed run/step/attempt metadata | Turn authorization assumptions into checks; align final names with workflow/infrastructure work. |
| 2026-10-25 | Record bootstrap as complete | PR #1 merged; caller validation and issuance still need their own evidence. |
| 2026-10-25 | Move the plan to the standalone broker repository under `docs/plans/` | Broker has its own repository; workflow/artifact services retain the separate platform-services repository. |
| 2026-10-25 | Use Fastify with no UI | Architect selected Fastify after comparison with Express; see the broker framework ADR. |
| 2026-10-25 | Use TypeScript, Node 24 and Vitest | Incorporate the architect's bootstrap PR review into the plan. |
| 2026-10-25 | Keep bootstrap and plan on independent branches | Review the foundation separately without stacking documentation on unmerged implementation. |
| 2026-10-25 | Plan broker first, with direct-pod verification before Argo/model integration | Establish identity and actual scope enforcement before adding execution layers. |
| 2026-10-25 | Propose trusted test assignments for the first proof | Avoid making the workflow service/database a prerequisite; production assignment admission remains later work. |
| 2026-10-25 | Evaluate artifact authentication after broker evidence | Kubernetes-native reuse is a candidate, not an adopted replacement for HMAC. |
