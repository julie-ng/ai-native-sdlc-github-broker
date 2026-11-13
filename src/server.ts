import { buildApp } from './app.js'
import { createGitHubTokenIssuer, GitHubTokenIssuerError } from './github-token-issuer.js'
import { createKubernetesAdapters } from './kubernetes-adapters.js'
import type { RepositoryAssignment } from './token-exchange.types.js'

// Fixed diagnostics only: never echo environment values or JSON parser errors.
function configurationError(message: string): never {
  console.error(message)
  process.exit(1)
}

let repositories: Record<string, RepositoryAssignment>
try {
  const value: unknown = JSON.parse(process.env.GH_REPOSITORIES ?? '')
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).length === 0
    || !Object.entries(value).every(([name, assignment]) => {
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name)
        || typeof assignment !== 'object' || assignment === null || Array.isArray(assignment)) {
        return false
      }
      const entry = assignment as Record<string, unknown>
      return Object.keys(entry).length === 2
        && Number.isSafeInteger(entry.repositoryId) && Number(entry.repositoryId) > 0
        && Number.isSafeInteger(entry.installationId) && Number(entry.installationId) > 0
    })) {
    throw new Error()
  }
  repositories = value as Record<string, RepositoryAssignment>
} catch {
  configurationError('GH_REPOSITORIES must be a nonempty owner/repo mapping with positive integer repositoryId and installationId')
}

let kubernetes: ReturnType<typeof createKubernetesAdapters>
try {
  kubernetes = createKubernetesAdapters()
} catch {
  configurationError('Invalid Kubernetes configuration: check KUBERNETES_API_URL and KUBERNETES_SERVICE_ACCOUNT_TOKEN_PATH')
}

let tokenIssuer: Awaited<ReturnType<typeof createGitHubTokenIssuer>>
try {
  tokenIssuer = await createGitHubTokenIssuer()
} catch (error) {
  configurationError(error instanceof GitHubTokenIssuerError ? error.message : 'GitHub issuer configuration invalid')
}

const HOST = process.env.HOST || '127.0.0.1'
const PORT = Number(process.env.PORT || 3000)

const app = buildApp({
  logger: {
    redact: ['req.headers.authorization'],
  },
}, {
  ...kubernetes,
  tokenIssuer,
  repositories,
})

async function shutdown() {
  try {
    await app.close()
  } catch (error) {
    app.log.error(error)
    process.exitCode = 1
  }
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

try {
  await app.listen({
    host: HOST,
    port: PORT,
  })
} catch (error) {
  app.log.error(error)
  process.exitCode = 1
}
