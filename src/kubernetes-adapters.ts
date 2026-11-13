import { readFile } from 'node:fs/promises'
import type { PodLookup, TokenValidator } from './token-exchange.types.js'

export class KubernetesDependencyError extends Error {
  constructor() {
    super('Kubernetes dependency unavailable')
    this.name = 'KubernetesDependencyError'
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && /^\S+$/.test(value)
}

// Namespace is a DNS label; pod and ServiceAccount names are DNS subdomains.
function name(value: unknown, namespace = false): value is string {
  return typeof value === 'string' && value.length <= (namespace ? 63 : 253)
    && (!namespace || !value.includes('.'))
    && value.split('.').every(label => /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(label))
}

function singleExtra(value: unknown): value is [string] {
  return Array.isArray(value) && value.length === 1 && nonempty(value[0])
}

export function createKubernetesAdapters(
  env: Partial<Pick<NodeJS.ProcessEnv, 'KUBERNETES_API_URL' | 'KUBERNETES_SERVICE_ACCOUNT_TOKEN_PATH'>> = process.env,
): {
  tokenValidator: TokenValidator
  podLookup: PodLookup
} {
  let api: URL
  try {
    api = new URL(env.KUBERNETES_API_URL ?? 'https://kubernetes.default.svc')
    if (api.protocol !== 'https:' || api.username || api.password || api.pathname !== '/' || api.search || api.hash) {
      throw new KubernetesDependencyError()
    }
  } catch {
    throw new KubernetesDependencyError()
  }
  const tokenPath = env.KUBERNETES_SERVICE_ACCOUNT_TOKEN_PATH ?? '/var/run/secrets/kubernetes.io/serviceaccount/token'

  async function request(path: string, options: RequestInit, expectedStatus: number): Promise<unknown> {
    try {
      // Read the mounted token per call so projected-token refreshes are observed.
      const token = (await readFile(tokenPath, 'utf8')).trim()
      if (!nonempty(token)) {
        throw new KubernetesDependencyError()
      }
      const response = await fetch(new URL(path, api), {
        ...options,
        headers: {
          ...options.headers,
          authorization: `Bearer ${token}`,
          accept: 'application/json',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      })
      if (response.status !== expectedStatus) {
        await response.body?.cancel()
        throw new KubernetesDependencyError()
      }
      try {
        return await response.json()
      } catch (error) {
        // A successful review with malformed JSON is an unauthenticated result.
        // Body transport failures still become dependency errors in the outer catch.
        if (error instanceof SyntaxError) {
          return undefined
        }
        throw error
      }
    } catch {
      // Neither API error bodies nor filesystem/network causes may escape.
      throw new KubernetesDependencyError()
    }
  }

  const tokenValidator: TokenValidator = async (token) => {
    const result = await request('/apis/authentication.k8s.io/v1/tokenreviews', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiVersion: 'authentication.k8s.io/v1',
        kind: 'TokenReview',
        spec: {
          token,
          audiences: ['token-broker'],
        },
      }),
    }, 201)
    const denied = {
      authenticated: false,
      audienceMatches: false,
    } as const
    if (!record(result) || !record(result.status)) {
      return denied
    }
    const status = result.status
    if (status.authenticated !== true || (status.error !== undefined && status.error !== '')
      || !Array.isArray(status.audiences) || !status.audiences.every(audience => typeof audience === 'string')
      || !status.audiences.includes('token-broker') || !record(status.user)) {
      return denied
    }
    const user = status.user
    const username = typeof user.username === 'string' ? user.username.split(':') : []
    if (username.length !== 4 || username[0] !== 'system' || username[1] !== 'serviceaccount'
      || !name(username[2], true) || !name(username[3]) || !record(user.extra)) {
      return denied
    }
    const podNames = user.extra['authentication.kubernetes.io/pod-name']
    const podUids = user.extra['authentication.kubernetes.io/pod-uid']
    if (!singleExtra(podNames) || !name(podNames[0]) || !singleExtra(podUids)) {
      return denied
    }
    return {
      authenticated: true,
      audienceMatches: true,
      namespace: username[2],
      serviceAccount: username[3],
      podName: podNames[0],
      podUid: podUids[0],
    }
  }

  const podLookup: PodLookup = async ({ namespace, podName }) => {
    if (!name(namespace, true) || !name(podName)) {
      throw new KubernetesDependencyError()
    }
    const result = await request(`/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(podName)}`, { method: 'GET' }, 200)
    if (!record(result) || !record(result.metadata) || !nonempty(result.metadata.uid)
      || !record(result.spec) || !name(result.spec.serviceAccountName)) {
      throw new KubernetesDependencyError()
    }
    const annotations = result.metadata.annotations ?? {}
    if (!record(annotations) || !Object.values(annotations).every(value => typeof value === 'string')) {
      throw new KubernetesDependencyError()
    }
    return {
      uid: result.metadata.uid,
      serviceAccount: result.spec.serviceAccountName,
      annotations: annotations as Record<string, string>,
    }
  }

  return {
    tokenValidator,
    podLookup,
  }
}
