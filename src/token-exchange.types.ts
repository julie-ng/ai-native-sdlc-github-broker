export type TokenReviewResult =
  | {
    authenticated: false
    audienceMatches: boolean
  }
  | {
    authenticated: true
    audienceMatches: boolean
    namespace: string
    serviceAccount: string
    podName: string
    podUid: string
  }

export interface TokenValidator {
  (token: string): Promise<TokenReviewResult>
}

export interface PodLookup {
  (pod: {
    namespace: string
    podName: string
  }): Promise<{
    uid: string
    serviceAccount: string
    annotations: Record<string, string>
  }>
}

export interface RepositoryAssignment {
  repositoryId: number
  installationId: number
}

export interface TokenPermissions {
  contents: 'read' | 'write'
  issues: 'read'
  pull_requests?: 'write'
}

export interface TokenIssuer {
  (assignment: RepositoryAssignment & { permissions: TokenPermissions }): Promise<{
    token: string
    expiresAt: string
  }>
}

export interface TokenExchangeOptions {
  tokenValidator: TokenValidator
  podLookup: PodLookup
  tokenIssuer: TokenIssuer
  repositories: Readonly<Record<string, RepositoryAssignment>>
}
