import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createKubernetesAdapters, KubernetesDependencyError } from '../src/kubernetes-adapters.js'
import { buildApp } from '../src/app.js'

const brokerToken = 'broker-private-token'
const reviewedToken = 'reviewed-private-token'
const extra = {
  'authentication.kubernetes.io/pod-name': ['coder-run-1'],
  'authentication.kubernetes.io/pod-uid': ['pod-uid-123'],
}
const user = {
  username: 'system:serviceaccount:agents:coder',
  extra,
}
const status = {
  authenticated: true,
  audiences: ['token-broker'],
  user,
}
const pod = {
  metadata: {
    uid: 'pod-uid-123',
    annotations: { 'ai-native-sdlc/repository': 'owner/repo' },
  },
  spec: { serviceAccountName: 'coder' },
}
const lookupInput = {
  namespace: 'agents',
  podName: 'coder-run-1',
}
const fetchMock = vi.fn<typeof fetch>()
let directory: string
let tokenPath: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'broker-kubernetes-'))
  tokenPath = join(directory, 'token')
  await writeFile(tokenPath, `${brokerToken}\n`)
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await rm(directory, {
    recursive: true,
    force: true,
  })
})

function adapters() {
  return createKubernetesAdapters({
    KUBERNETES_API_URL: 'https://cluster.example',
    KUBERNETES_SERVICE_ACCOUNT_TOKEN_PATH: tokenPath,
  })
}

test('reviews only the caller token in the body and authenticates with the broker token in the header', async () => {
  fetchMock.mockResolvedValue(Response.json({ status }, { status: 201 }))
  const { tokenValidator } = adapters()
  expect(await tokenValidator(reviewedToken)).toEqual({
    authenticated: true,
    audienceMatches: true,
    namespace: 'agents',
    serviceAccount: 'coder',
    podName: 'coder-run-1',
    podUid: 'pod-uid-123',
  })
  const [url, options] = fetchMock.mock.calls[0]
  expect(String(url)).toBe('https://cluster.example/apis/authentication.k8s.io/v1/tokenreviews')
  expect(options?.method).toBe('POST')
  expect(JSON.parse(options?.body as string)).toEqual({
    apiVersion: 'authentication.k8s.io/v1',
    kind: 'TokenReview',
    spec: {
      token: reviewedToken,
      audiences: ['token-broker'],
    },
  })
  expect(options?.body).not.toContain(brokerToken)
  expect(new Headers(options?.headers).get('authorization')).toBe(`Bearer ${brokerToken}`)
  expect(JSON.stringify(options?.headers)).not.toContain(reviewedToken)
  expect(String(url)).not.toContain(brokerToken)
  expect(options?.redirect).toBe('error')
})

test.each([
  { authenticated: false },
  {
    authenticated: false,
    error: `${reviewedToken} rejected`,
  },
  {
    ...status,
    error: `${reviewedToken} rejected`,
  },
  {
    ...status,
    error: null,
  },
  {
    ...status,
    authenticated: 'true',
  },
  {
    ...status,
    audiences: undefined,
  },
  {
    ...status,
    audiences: ['kubernetes'],
  },
  {
    ...status,
    audiences: ['token-broker', 42],
  },
  {
    ...status,
    user: undefined,
  },
  {
    ...status,
    user: {
      ...user,
      username: 'human-user',
    },
  },
  {
    ...status,
    user: {
      ...user,
      username: 'system:serviceaccount:agents:coder:extra',
    },
  },
  {
    ...status,
    user: {
      ...user,
      username: 'system:serviceaccount:../agents:coder',
    },
  },
  {
    ...status,
    user: {
      ...user,
      extra: undefined,
    },
  },
  {
    ...status,
    user: {
      ...user,
      extra: {
        ...extra,
        'authentication.kubernetes.io/pod-name': [],
      },
    },
  },
  {
    ...status,
    user: {
      ...user,
      extra: {
        ...extra,
        'authentication.kubernetes.io/pod-name': ['first', 'second'],
      },
    },
  },
  {
    ...status,
    user: {
      ...user,
      extra: {
        ...extra,
        'authentication.kubernetes.io/pod-name': ['../other'],
      },
    },
  },
  {
    ...status,
    user: {
      ...user,
      extra: {
        ...extra,
        'authentication.kubernetes.io/pod-uid': 'not-an-array',
      },
    },
  },
  {
    ...status,
    user: {
      ...user,
      extra: {
        ...extra,
        'authentication.kubernetes.io/pod-uid': [''],
      },
    },
  },
  undefined,
])('returns unauthenticated for rejected or malformed review status %#', async (reviewStatus) => {
  const logs = [
    vi.spyOn(console, 'log'),
    vi.spyOn(console, 'warn'),
    vi.spyOn(console, 'error'),
  ]
  fetchMock.mockResolvedValue(Response.json({ status: reviewStatus }, { status: 201 }))
  const result = await adapters().tokenValidator(reviewedToken)
  expect(result).toEqual({
    authenticated: false,
    audienceMatches: false,
  })
  expect(JSON.stringify(result)).not.toContain(reviewedToken)
  logs.forEach(log => expect(log).not.toHaveBeenCalled())
})

test('accepts an empty status.error and additional compatible audiences', async () => {
  fetchMock.mockResolvedValue(Response.json({
    status: {
      ...status,
      error: '',
      audiences: ['other', 'token-broker'],
    },
  }, { status: 201 }))
  expect(await adapters().tokenValidator(reviewedToken)).toMatchObject({
    authenticated: true,
    audienceMatches: true,
  })
})

test('looks up the bound pod and observes mounted broker token changes on subsequent calls', async () => {
  fetchMock.mockImplementation(async () => Response.json(pod))
  const { podLookup } = adapters()
  expect(await podLookup(lookupInput)).toEqual({
    uid: 'pod-uid-123',
    serviceAccount: 'coder',
    annotations: pod.metadata.annotations,
  })
  await writeFile(tokenPath, 'refreshed-broker-token\n')
  await podLookup(lookupInput)
  const [url, options] = fetchMock.mock.calls[0]
  expect(String(url)).toBe('https://cluster.example/api/v1/namespaces/agents/pods/coder-run-1')
  expect(options?.method).toBe('GET')
  expect(options?.body).toBeUndefined()
  expect(options?.redirect).toBe('error')
  expect(new Headers(options?.headers).get('authorization')).toBe(`Bearer ${brokerToken}`)
  expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('authorization')).toBe('Bearer refreshed-broker-token')
})

test('a pod without annotations returns an empty annotation map', async () => {
  fetchMock.mockResolvedValue(Response.json({
    metadata: { uid: 'pod-uid-123' },
    spec: pod.spec,
  }))
  expect(await adapters().podLookup(lookupInput)).toMatchObject({ annotations: {} })
})

test.each([
  {},
  {
    ...pod,
    metadata: { annotations: {} },
  },
  {
    ...pod,
    spec: {},
  },
  {
    ...pod,
    metadata: {
      ...pod.metadata,
      annotations: { secret: 123 },
    },
  },
])('malformed pod response is a dependency error %#', async (response) => {
  fetchMock.mockResolvedValue(Response.json(response))
  await expect(adapters().podLookup(lookupInput)).rejects.toBeInstanceOf(KubernetesDependencyError)
})

test.each(['review', 'pod'] as const)('%s failures are typed and expose no API body, headers, tokens or cause', async (operation) => {
  const logs = [
    vi.spyOn(console, 'log'),
    vi.spyOn(console, 'warn'),
    vi.spyOn(console, 'error'),
  ]
  for (const failure of [
    401,
    403,
    404,
    500,
    503,
    'network',
    'timeout',
    'redirect',
  ] as const) {
    fetchMock.mockImplementation(async () => {
      if (typeof failure === 'number') {
        return new Response(`${brokerToken} ${reviewedToken}`, {
          status: failure,
          headers: { authorization: brokerToken },
        })
      }
      throw new Error(`${failure}: ${brokerToken} ${reviewedToken}`)
    })
    const { tokenValidator, podLookup } = adapters()
    const error = await (operation === 'review' ? tokenValidator(reviewedToken) : podLookup(lookupInput)).catch(error => error)
    expect(error).toBeInstanceOf(KubernetesDependencyError)
    expect(error.message).toBe('Kubernetes dependency unavailable')
    expect(error.cause).toBeUndefined()
    expect(String(error.stack)).not.toContain(brokerToken)
    expect(String(error.stack)).not.toContain(reviewedToken)
  }
  logs.forEach(log => expect(log).not.toHaveBeenCalled())
})

test.each(['review', 'pod'] as const)('%s supplies a 30-second abort signal and handles aborts', async (operation) => {
  const controller = new AbortController()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
  fetchMock.mockImplementation(async (_url, options) => {
    const signal = options?.signal
    expect(signal).toBeInstanceOf(AbortSignal)
    // Trigger the timeout signal without waiting 30 seconds in the test.
    return new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
      controller.abort(new DOMException('Request timed out', 'TimeoutError'))
    })
  })
  const { tokenValidator, podLookup } = adapters()
  await expect(operation === 'review' ? tokenValidator(reviewedToken) : podLookup(lookupInput)).rejects.toBeInstanceOf(KubernetesDependencyError)
  expect(timeout).toHaveBeenCalledExactlyOnceWith(30_000)
})

test('invalid JSON on a successful review denies authentication, but on a pod lookup is a dependency error', async () => {
  fetchMock.mockImplementation(async () => new Response('invalid JSON'))
  const { tokenValidator, podLookup } = adapters()
  fetchMock.mockResolvedValueOnce(new Response('invalid JSON', { status: 201 }))
  expect(await tokenValidator(reviewedToken)).toEqual({
    authenticated: false,
    audienceMatches: false,
  })
  await expect(podLookup(lookupInput)).rejects.toBeInstanceOf(KubernetesDependencyError)
})

test('unreadable or empty broker token files fail without making an API request', async () => {
  const { tokenValidator } = adapters()
  await writeFile(tokenPath, '\n')
  await expect(tokenValidator(reviewedToken)).rejects.toBeInstanceOf(KubernetesDependencyError)
  await rm(tokenPath)
  await expect(tokenValidator(reviewedToken)).rejects.toBeInstanceOf(KubernetesDependencyError)
  expect(fetchMock).not.toHaveBeenCalled()
})

test('the endpoint maps a rejected TokenReview to 401 and a failed API request to 503 without issuing', async () => {
  const tokenIssuer = vi.fn()
  const app = buildApp({}, {
    ...adapters(),
    tokenIssuer,
    repositories: {},
  })
  try {
    fetchMock.mockResolvedValueOnce(Response.json({
      status: {
        authenticated: false,
        error: reviewedToken,
      },
    }, { status: 201 }))
    fetchMock.mockRejectedValueOnce(new Error(brokerToken))
    for (const [httpStatus, code] of [[401, 'invalid_credential'], [503, 'dependency_unavailable']] as const) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/github-token',
        headers: { authorization: `Bearer ${reviewedToken}` },
      })
      expect(response.statusCode).toBe(httpStatus)
      expect(response.json()).toEqual({ error: { code } })
    }
    expect(tokenIssuer).not.toHaveBeenCalled()
  } finally {
    await app.close()
  }
})
