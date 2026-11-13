import { Writable } from 'node:stream'
import { expect, test, vi } from 'vitest'
import { buildApp } from '../../../src/app.js'
import type { PodLookup, TokenIssuer, TokenValidator } from '../../../src/token-exchange.types.js'

const identity = {
  authenticated: true as const,
  audienceMatches: true,
  namespace: 'agents',
  serviceAccount: 'planner',
  podName: 'planner-123',
  podUid: 'pod-uid',
}
const repository = 'julie-ng/aks-architect-ai'
const annotation = 'ai-native-sdlc/repository'
const pod = { uid: 'pod-uid', serviceAccount: 'planner', annotations: { [annotation]: repository } }
const issued = { token: 'ghs-issued-secret', expiresAt: '2026-11-13T12:00:00Z' }
const headers = { authorization: 'Bearer projected-secret' }

function fixture() {
  const tokenValidator = vi.fn<TokenValidator>().mockResolvedValue({ ...identity })
  const podLookup = vi.fn<PodLookup>().mockResolvedValue({ ...pod })
  const tokenIssuer = vi.fn<TokenIssuer>().mockResolvedValue({ ...issued })
  let logs = ''
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      logs += chunk.toString()
      callback()
    },
  })
  const app = buildApp({ logger: { stream, redact: ['req.headers.authorization'] } }, {
    tokenValidator,
    podLookup,
    tokenIssuer,
    repositories: {
      [repository]: { repositoryId: 123, installationId: 456 },
      'other/repo': { repositoryId: 789, installationId: 987 },
    },
  })
  return { app, tokenValidator, podLookup, tokenIssuer, logs: () => logs }
}

for (const role of ['planner', 'coder']) {
  test(`issues a scoped token for ${role}`, async ({ onTestFinished }) => {
    const f = fixture()
    onTestFinished(() => f.app.close())
    f.tokenValidator.mockResolvedValue({ ...identity, serviceAccount: role })
    f.podLookup.mockResolvedValue({ ...pod, serviceAccount: role })

    const response = await f.app.inject({ method: 'POST', url: '/v1/github-token', headers })
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json()).toEqual(issued)
    expect(f.tokenValidator).toHaveBeenCalledExactlyOnceWith('projected-secret')
    expect(f.podLookup).toHaveBeenCalledExactlyOnceWith({ namespace: 'agents', podName: 'planner-123' })
    expect(f.tokenIssuer).toHaveBeenCalledExactlyOnceWith({
      repositoryId: 123,
      installationId: 456,
      permissions: role === 'planner'
        ? { contents: 'read', issues: 'read' }
        : { contents: 'write', pull_requests: 'write', issues: 'read' },
    })
    expect(f.tokenValidator.mock.invocationCallOrder[0]).toBeLessThan(f.podLookup.mock.invocationCallOrder[0])
    expect(f.podLookup.mock.invocationCallOrder[0]).toBeLessThan(f.tokenIssuer.mock.invocationCallOrder[0])
    expect(f.logs()).not.toContain('projected-secret')
    expect(f.logs()).not.toContain(issued.token)
  })
}

test('accepts an empty JSON object', async ({ onTestFinished }) => {
  const f = fixture()
  onTestFinished(() => f.app.close())
  const response = await f.app.inject({ method: 'POST', url: '/v1/github-token', headers, payload: {} })
  expect(response.statusCode).toBe(200)
  expect(f.tokenIssuer).toHaveBeenCalledOnce()
})

for (const authorization of [undefined, '', 'Basic secret', 'Bearer', 'Bearer ', 'Bearer a b', 'Bearer a,b']) {
  test(`rejects malformed authorization: ${JSON.stringify(authorization)}`, async ({ onTestFinished }) => {
    const f = fixture()
    onTestFinished(() => f.app.close())
    const response = await f.app.inject({
      method: 'POST', url: '/v1/github-token', headers: authorization === undefined ? {} : { authorization },
    })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: { code: 'invalid_credential' } })
    expect(f.tokenValidator).not.toHaveBeenCalled()
    expect(f.podLookup).not.toHaveBeenCalled()
    expect(f.tokenIssuer).not.toHaveBeenCalled()
  })
}

for (const review of [{ authenticated: false as const, audienceMatches: false }, { ...identity, audienceMatches: false }]) {
  test(`rejects failed review or audience: ${JSON.stringify(review)}`, async ({ onTestFinished }) => {
    const f = fixture()
    onTestFinished(() => f.app.close())
    f.tokenValidator.mockResolvedValue(review)
    const response = await f.app.inject({ method: 'POST', url: '/v1/github-token', headers })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: { code: 'invalid_credential' } })
    expect(f.podLookup).not.toHaveBeenCalled()
    expect(f.tokenIssuer).not.toHaveBeenCalled()
  })
}

for (const claim of [
  { serviceAccount: 'reviewer' },
  { serviceAccount: 'toString' },
  { namespace: 'default' },
]) {
  test(`denies unauthorized claims: ${JSON.stringify(claim)}`, async ({ onTestFinished }) => {
    const f = fixture()
    onTestFinished(() => f.app.close())
    f.tokenValidator.mockResolvedValue({ ...identity, ...claim })
    const response = await f.app.inject({ method: 'POST', url: '/v1/github-token', headers })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: { code: 'assignment_denied' } })
    expect(f.podLookup).not.toHaveBeenCalled()
    expect(f.tokenIssuer).not.toHaveBeenCalled()
  })
}

for (const mismatch of [{ uid: 'replacement-pod' }, { serviceAccount: 'coder' }]) {
  test(`denies pod mismatch: ${JSON.stringify(mismatch)}`, async ({ onTestFinished }) => {
    const f = fixture()
    onTestFinished(() => f.app.close())
    f.podLookup.mockResolvedValue({ ...pod, ...mismatch })
    const response = await f.app.inject({ method: 'POST', url: '/v1/github-token', headers })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: { code: 'assignment_denied' } })
    expect(f.tokenIssuer).not.toHaveBeenCalled()
  })
}

for (const value of [undefined, '', 'repo', '/repo', 'owner/', 'a/b/c', 'owner/repo name', ' owner/repo', 'owner/other']) {
  test(`denies missing, malformed or unapproved repository: ${JSON.stringify(value)}`, async ({ onTestFinished }) => {
    const f = fixture()
    onTestFinished(() => f.app.close())
    f.podLookup.mockResolvedValue({ ...pod, annotations: value === undefined ? {} : { [annotation]: value } })
    const response = await f.app.inject({ method: 'POST', url: '/v1/github-token', headers })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: { code: 'assignment_denied' } })
    expect(f.tokenIssuer).not.toHaveBeenCalled()
  })
}

test('selects the annotated repository rather than the first allowlist entry', async ({ onTestFinished }) => {
  const f = fixture()
  onTestFinished(() => f.app.close())
  f.podLookup.mockResolvedValue({ ...pod, annotations: { [annotation]: 'other/repo' } })
  const response = await f.app.inject({ method: 'POST', url: '/v1/github-token', headers })
  expect(response.statusCode).toBe(200)
  expect(f.tokenIssuer).toHaveBeenCalledExactlyOnceWith({
    repositoryId: 789, installationId: 987, permissions: { contents: 'read', issues: 'read' },
  })
})

for (const payload of [
  { repository: repository }, { role: 'coder' }, { permissions: { contents: 'write' } },
  { installation: 456 }, { installationId: 456 }, { repositoryId: 123 }, { arbitrary: true },
  [], 'null', 'true', '123', '"text"', '{"repository":',
]) {
  test(`rejects invalid body: ${JSON.stringify(payload)}`, async ({ onTestFinished }) => {
    const f = fixture()
    onTestFinished(() => f.app.close())
    const response = await f.app.inject({
      method: 'POST', url: '/v1/github-token',
      headers: { ...headers, 'content-type': 'application/json' }, payload,
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: { code: 'invalid_request' } })
    expect(f.tokenValidator).not.toHaveBeenCalled()
    expect(f.podLookup).not.toHaveBeenCalled()
    expect(f.tokenIssuer).not.toHaveBeenCalled()
    expect(f.logs()).not.toContain('projected-secret')
  })
}

for (const query of ['?repository=other/repo', '?role=coder', '?arbitrary']) {
  test(`rejects any query string: ${query}`, async ({ onTestFinished }) => {
    const f = fixture()
    onTestFinished(() => f.app.close())
    const response = await f.app.inject({ method: 'POST', url: `/v1/github-token${query}`, headers })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: { code: 'invalid_request' } })
    expect(f.tokenValidator).not.toHaveBeenCalled()
    expect(f.podLookup).not.toHaveBeenCalled()
    expect(f.tokenIssuer).not.toHaveBeenCalled()
  })
}

test('rejects a bare query delimiter on the raw request', async ({ onTestFinished }) => {
  const f = fixture()
  onTestFinished(() => f.app.close())
  // inject() normalizes a trailing '?' away; preserve the HTTP request target here.
  f.app.addHook('onRequest', (request, _reply, done) => {
    request.raw.url += '?'
    done()
  })
  const response = await f.app.inject({ method: 'POST', url: '/v1/github-token', headers })
  expect(response.statusCode).toBe(400)
  expect(response.json()).toEqual({ error: { code: 'invalid_request' } })
  expect(f.tokenIssuer).not.toHaveBeenCalled()
})

test('rejects unsupported content types with the contract error', async ({ onTestFinished }) => {
  const f = fixture()
  onTestFinished(() => f.app.close())
  const response = await f.app.inject({
    method: 'POST', url: '/v1/github-token', headers: { ...headers, 'content-type': 'application/xml' }, payload: '<body/>',
  })
  expect(response.statusCode).toBe(400)
  expect(response.json()).toEqual({ error: { code: 'invalid_request' } })
  expect(f.tokenIssuer).not.toHaveBeenCalled()
})

for (const dependency of ['tokenValidator', 'podLookup', 'tokenIssuer'] as const) {
  test(`sanitizes ${dependency} failures in response and logs`, async ({ onTestFinished }) => {
    const f = fixture()
    onTestFinished(() => f.app.close())
    const upstreamDetail = `upstream-private-body projected-secret ${issued.token}`
    f[dependency].mockRejectedValue(new Error(upstreamDetail))
    const response = await f.app.inject({ method: 'POST', url: '/v1/github-token', headers })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ error: { code: 'dependency_unavailable' } })
    if (dependency === 'tokenValidator') expect(f.podLookup).not.toHaveBeenCalled()
    if (dependency !== 'tokenIssuer') expect(f.tokenIssuer).not.toHaveBeenCalled()
    else expect(f.tokenIssuer).toHaveBeenCalledOnce()
    // Wait for request-completion logging before checking that no secret escaped.
    await f.app.close()
    for (const secret of ['upstream-private-body', 'projected-secret', issued.token]) {
      expect(response.body).not.toContain(secret)
      expect(f.logs()).not.toContain(secret)
    }
  })
}
