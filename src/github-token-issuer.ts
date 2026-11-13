import { createPrivateKey } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createAppAuth } from '@octokit/auth-app'
import type { TokenIssuer } from './token-exchange.types.js'

export class GitHubTokenIssuerError extends Error {
  constructor(message:
    | 'GH_APP_ID missing or not numeric'
    | 'GH_APP_PRIVATE_KEY_PATH missing'
    | 'Private key file unreadable'
    | 'Private key is invalid'
    | 'Private key is not RSA'
    | 'GitHub token issuance unavailable' = 'GitHub token issuance unavailable') {
    super(message)
    this.name = 'GitHubTokenIssuerError'
  }
}

// Call once during startup. Server wiring is deliberately separate from this adapter.
export async function createGitHubTokenIssuer(
  env: Partial<Pick<NodeJS.ProcessEnv, 'GH_APP_ID' | 'GH_APP_PRIVATE_KEY_PATH'>> = process.env,
): Promise<TokenIssuer> {
  try {
    const appId = env.GH_APP_ID
    const keyPath = env.GH_APP_PRIVATE_KEY_PATH
    if (!appId || !/^\d+$/.test(appId)) {
      throw new GitHubTokenIssuerError('GH_APP_ID missing or not numeric')
    }
    if (!keyPath) {
      throw new GitHubTokenIssuerError('GH_APP_PRIVATE_KEY_PATH missing')
    }
    let pem: string
    try {
      pem = await readFile(keyPath, 'utf8')
    } catch {
      throw new GitHubTokenIssuerError('Private key file unreadable')
    }
    // Node accepts GitHub's PKCS#1 PEM; export PKCS#8 for the auth library.
    let key: ReturnType<typeof createPrivateKey>
    try {
      key = createPrivateKey(pem)
    } catch {
      throw new GitHubTokenIssuerError('Private key is invalid')
    }
    if (key.asymmetricKeyType !== 'rsa') {
      throw new GitHubTokenIssuerError('Private key is not RSA')
    }
    const auth = createAppAuth({
      appId,
      privateKey: key.export({
        type: 'pkcs8',
        format: 'pem',
      }).toString(),
    })
    return async ({
      repositoryId, installationId, permissions,
    }) => {
      try {
        // Reject missing scope even for callers outside TypeScript; JSON must never
        // omit either field and silently inherit the installation's full grants.
        const scope = { ...permissions }
        if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0
          || !Number.isSafeInteger(installationId) || installationId <= 0
          || !['read', 'write'].includes(scope.contents) || scope.issues !== 'read'
          || (scope.pull_requests !== undefined && scope.pull_requests !== 'write')
          || Object.keys(scope).some(key => ![
            'contents',
            'issues',
            'pull_requests',
          ].includes(key))) {
          throw new GitHubTokenIssuerError()
        }
        const { token: jwt } = await auth({ type: 'app' })
        // Use only App JWT authentication, never Octokit's installation-token API
        // or its cache. Every issuance makes a fresh, explicitly scoped request.
        const response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${jwt}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2026-03-10',
            'user-agent': 'ai-native-sdlc-github-broker',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            repository_ids: [repositoryId],
            permissions: scope,
          }),
        })
        if (!response.ok) {
          await response.body?.cancel()
          throw new GitHubTokenIssuerError()
        }
        const result: unknown = await response.json()
        if (typeof result !== 'object' || result === null
          || !('token' in result) || typeof result.token !== 'string' || !result.token
          || !('expires_at' in result) || typeof result.expires_at !== 'string'
          || !Number.isFinite(Date.parse(result.expires_at))) {
          throw new GitHubTokenIssuerError()
        }
        return {
          token: result.token,
          expiresAt: result.expires_at,
        }
      } catch {
        // No cause: upstream exceptions can contain credentials, headers or bodies.
        throw new GitHubTokenIssuerError()
      }
    }
  } catch (error) {
    // Preserve only our fixed startup reasons, never raw filesystem/crypto errors.
    if (error instanceof GitHubTokenIssuerError) {
      throw error
    }
    throw new GitHubTokenIssuerError()
  }
}
