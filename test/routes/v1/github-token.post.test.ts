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
