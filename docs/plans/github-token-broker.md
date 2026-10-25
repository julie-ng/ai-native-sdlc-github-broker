# GitHub token broker — implementation plan

> [!NOTE]
> Draft for review, 2026-10-25. No broker implementation or runtime proof yet. Steps below are proposed work; record results as each layer is built.

## Scope and design references

Build the standalone GitHub token broker as the first platform service, using TypeScript and Fastify on Node 24 LTS, with Vitest for tests. It has its own repository/deployment and no UI. Prove pod authentication and repository/role-scoped GitHub access, then evaluate reuse for artifact authentication. [Framework decision](../architecture/decisions/001-fastify.md).

- [Broker architecture](https://github.com/julie-ng/ai-native-sdlc/blob/main/architecture/reference/token-broker.md): credential flow and trust model.
- [ADR-003](https://github.com/julie-ng/ai-native-sdlc/blob/main/architecture/decisions/003-platform-services-vs-agent-pods.md): trusted services versus untrusted agent pods.
- [ADR-012](https://github.com/julie-ng/ai-native-sdlc/blob/main/architecture/decisions/012-agent-identity-commits-vs-github-tokens.md): short-lived, per-step GitHub access.
- [ADR-014](https://github.com/julie-ng/ai-native-sdlc/blob/main/architecture/decisions/014-commit-signing.md): native Git and separate role GPG keys; signing is independent of the broker.

Service code and its tests belong in this repository. Build plans live in `docs/plans/`; broker-specific ADRs live in `docs/architecture/decisions/`. Platform-wide decisions remain in the parent architecture repository. Cluster identity/RBAC changes belong in the infrastructure repository; Argo templates belong in the workflows repository. The architect applies Azure/cluster changes and reports runtime results.

## Steps

### 0. Merge the Fastify bootstrap

Review the independent bootstrap branch before implementing the exchange: application factory, server entry point, health endpoint, logging, npm lockfile, lint, TypeScript build/type checking and Vitest process tests. It needs no Kubernetes, GitHub or Azure credentials.

**Go/no-go:** a clean install, lint, type checking, build and startup/shutdown checks pass on Node 24. This establishes the service foundation, not broker authentication or issuance. This documentation branch can be reviewed/merged independently.

### 1. Set the initial permission and assignment contract

- Start with two test roles: contents-read and contents-write. Use the existing broker role table to add issue comments, review comments and PR creation after the basic exchange works.
- Confirm the intended GitHub App, human owner, installation and selected repositories. Use disposable private repositories A and B; install the App on both so the test can distinguish token downscoping from installation restrictions.
- Record the trusted assignment fields: workflow run ID, logical step ID, attempt, repository and ServiceAccount. A run contains multiple step/attempt pods; a pod is not the whole run.
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

- App registration/installation details and Kubernetes/GitHub client libraries.
- Exact assignment schema and trusted producer after the test-manifest stage.
- Broker key loading/rotation, credential transport and client token handling.
- Operational defaults: timeouts/retries, issuance caching policy, readiness and availability.
- Architect/coder permission alignment and signing-key delivery before real coding runs.

## Verification status

2026-10-25: plan checked against accepted platform ADRs and linked primary Kubernetes/GitHub documentation. No App configuration, cluster permissions, token exchange or GitHub operations tested for this broker. Infrastructure prerequisites must be inspected before implementation; this checkout does not establish their deployed state.

## Decision log

| Date | Decision / proposal | Reasoning |
|---|---|---|
| 2026-10-25 | Move the plan to the standalone broker repository under `docs/plans/` | Broker has its own repository; workflow/artifact services retain the separate platform-services repository. |
| 2026-10-25 | Use Fastify with no UI | Architect selected Fastify after comparison with Express; see the broker framework ADR. |
| 2026-10-25 | Use TypeScript, Node 24 and Vitest | Incorporate the architect's bootstrap PR review into the plan. |
| 2026-10-25 | Keep bootstrap and plan on independent branches | Review the foundation separately without stacking documentation on unmerged implementation. |
| 2026-10-25 | Plan broker first, with direct-pod verification before Argo/model integration | Establish identity and actual scope enforcement before adding execution layers. |
| 2026-10-25 | Propose trusted test assignments for the first proof | Avoid making the workflow service/database a prerequisite; production assignment admission remains later work. |
| 2026-10-25 | Evaluate artifact authentication after broker evidence | Kubernetes-native reuse is a candidate, not an adopted replacement for HMAC. |
