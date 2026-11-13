import { generateKeyPairSync, verify } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createGitHubTokenIssuer, GitHubTokenIssuerError } from '../src/github-token-issuer.js'
import type { TokenIssuer, TokenPermissions } from '../src/token-exchange.types.js'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pem = privateKey.export({
  type: 'pkcs1',
  format: 'pem',
}).toString()
const expiresAt = '2026-11-13T12:00:00Z'
const assignment = {
  repositoryId: 42,
  installationId: 17,
  permissions: {
    contents: 'read',
    issues: 'read',
  } as TokenPermissions,
}
const fetchMock = vi.fn<typeof fetch>()
let directory: string
let keyPath: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'broker-key-'))
  keyPath = join(directory, 'private.pem')
  await writeFile(keyPath, pem)
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => Response.json({
    token: 'scoped-token',
    expires_at: expiresAt,
  }, { status: 201 }))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await rm(directory, {
    recursive: true,
    force: true,
  })
})

function issuer() {
  return createGitHubTokenIssuer({
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
  })
}

test('uses a startup-loaded PKCS#1 key and sends exactly one repository and explicit permissions', async () => {
  const issue = await issuer()
  await rm(keyPath)
  const now = Math.floor(Date.now() / 1000)
  expect(await issue(assignment)).toEqual({
    token: 'scoped-token',
    expiresAt,
  })
  const [url, options] = fetchMock.mock.calls[0]
  expect(url).toBe('https://api.github.com/app/installations/17/access_tokens')
  expect(options?.method).toBe('POST')
  expect(JSON.parse(options?.body as string)).toEqual({
    repository_ids: [42],
    permissions: assignment.permissions,
  })
  const jwt = new Headers(options?.headers).get('authorization')!.slice('Bearer '.length)
  const [
    header,
    payload,
    signature,
  ] = jwt.split('.')
  expect(JSON.parse(Buffer.from(header, 'base64url').toString()).alg).toBe('RS256')
  expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url'))).toBe(true)
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
  expect(claims.iss).toBe('12345')
  expect(claims.iat).toBeLessThanOrEqual(now)
  expect(claims.exp).toBeGreaterThan(now)
  expect(claims.exp).toBeLessThanOrEqual(now + 600)
  expect(claims.exp - claims.iat).toBeLessThanOrEqual(600)
})

test('does not reuse tokens across repositories, permissions, installations or repeated assignments', async () => {
  const issue = await issuer()
  const scopes = [
    assignment,
    {
      ...assignment,
      repositoryId: 43,
    },
    {
      ...assignment,
      permissions: {
        contents: 'write',
        issues: 'read',
        pull_requests: 'write',
      } as TokenPermissions,
    },
    {
      ...assignment,
      installationId: 18,
    },
    assignment,
  ]
  let count = 0
  fetchMock.mockImplementation(async () => Response.json({
    token: `token-${++count}`,
    expires_at: expiresAt,
  }))
  const results = await Promise.all(scopes.map(scope => issue(scope)))
  expect(new Set(results.map(result => result.token)).size).toBe(scopes.length)
  expect(fetchMock).toHaveBeenCalledTimes(scopes.length)
  // Signing completes asynchronously; compare scopes without assuming call order.
  const requests = fetchMock.mock.calls.map(([url, options]) => JSON.stringify({
    url,
    body: JSON.parse(options?.body as string),
  })).sort()
  const expected = scopes.map(scope => JSON.stringify({
    url: `https://api.github.com/app/installations/${scope.installationId}/access_tokens`,
    body: {
      repository_ids: [scope.repositoryId],
      permissions: scope.permissions,
    },
  })).sort()
  expect(requests).toEqual(expected)
})

test.each([
  401,
  403,
  404,
  422,
  429,
  500,
  503,
  'network',
  'invalid-json',
  'invalid-result',
])(
  'sanitizes %s failures without logging upstream secrets', async (failure) => {
    const secret = 'upstream-secret-token-and-headers'
    const logs = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
    ]
    const issue = await issuer()
    fetchMock.mockImplementation(async () => {
      if (failure === 'network') {
        throw new Error(secret)
      }
      if (failure === 'invalid-json') {
        return new Response(secret)
      }
      if (failure === 'invalid-result') {
        return Response.json({
          token: secret,
          expires_at: 'invalid',
        })
      }
      return new Response(secret, {
        status: typeof failure === 'number' ? failure : 500,
        headers: { authorization: secret },
      })
    })
    const error = await issue(assignment).catch(error => error)
    expect(error).toBeInstanceOf(GitHubTokenIssuerError)
    expect(error.message).toBe('GitHub token issuance unavailable')
    expect(error.cause).toBeUndefined()
    expect(JSON.stringify(error)).not.toContain(secret)
    expect(String(error.stack)).not.toContain(secret)
    logs.forEach(log => expect(log).not.toHaveBeenCalled())
  },
)

test.each([
  {
    ...assignment,
    repositoryId: undefined,
  },
  {
    ...assignment,
    repositoryId: 0,
  },
  {
    ...assignment,
    installationId: undefined,
  },
  {
    ...assignment,
    permissions: undefined,
  },
  {
    ...assignment,
    permissions: {},
  },
])('rejects incomplete scope before contacting GitHub: %j', async (scope) => {
  const issue = await issuer()
  await expect(issue(scope as Parameters<TokenIssuer>[0])).rejects.toBeInstanceOf(GitHubTokenIssuerError)
  expect(fetchMock).not.toHaveBeenCalled()
})

test.each([
  ['missing-app', 'GITHUB_APP_ID missing or not numeric'],
  ['invalid-app', 'GITHUB_APP_ID missing or not numeric'],
  ['missing-path', 'GITHUB_APP_PRIVATE_KEY_PATH missing'],
  ['unreadable-key', 'Private key file unreadable'],
  ['invalid-key', 'Private key is invalid'],
  ['non-rsa-key', 'Private key is not RSA'],
])('reports safe startup reason: %s', async (failure, message) => {
  const secret = 'private-secret-invalid-key'
  const logs = [
    vi.spyOn(console, 'log'),
    vi.spyOn(console, 'warn'),
    vi.spyOn(console, 'error'),
  ]
  if (failure === 'invalid-key') {
    await writeFile(keyPath, secret)
  }
  if (failure === 'non-rsa-key') {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    await writeFile(keyPath, privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    }))
  }
  const error = await createGitHubTokenIssuer({
    GITHUB_APP_ID: failure === 'missing-app' ? undefined : failure === 'invalid-app' ? secret : '12345',
    GITHUB_APP_PRIVATE_KEY_PATH: failure === 'missing-path' ? undefined : failure === 'unreadable-key' ? join(directory, secret) : keyPath,
  }).catch(error => error)
  expect(error).toBeInstanceOf(GitHubTokenIssuerError)
  expect(error.message).toBe(message)
  expect(error.cause).toBeUndefined()
  expect(String(error.stack)).not.toContain(secret)
  expect(String(error.stack)).not.toContain(pem)
  expect(String(error.stack)).not.toContain(keyPath)
  logs.forEach(log => expect(log).not.toHaveBeenCalled())
  expect(fetchMock).not.toHaveBeenCalled()
})
