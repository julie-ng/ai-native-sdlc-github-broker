import type { FastifyPluginAsync } from 'fastify'
import type { TokenExchangeOptions, TokenPermissions } from '../../token-exchange.types.js'

const permissionsByRole = {
  planner: {
    contents: 'read',
    issues: 'read',
  },
  coder: {
    contents: 'write',
    pull_requests: 'write',
    issues: 'read',
  },
} satisfies Record<string, TokenPermissions>

const githubTokenRoute: FastifyPluginAsync<TokenExchangeOptions> = async (app, options) => {
  app.post('/v1/github-token', {
    // Scope parser/validation failures to this route; never expose parser input or errors.
    errorHandler(error, _request, reply) {
      const invalidRequest = error.statusCode !== undefined && error.statusCode < 500
      return reply.code(invalidRequest ? 400 : 503).send({
        error: { code: invalidRequest ? 'invalid_request' : 'dependency_unavailable' },
      })
    },
    preValidation(request, reply, done) {
      // Validate before AJV can strip extra properties or coerce agent-controlled input.
      const body = request.body
      if (request.raw.url?.includes('?')
        || (body !== undefined && (body === null || typeof body !== 'object'
          || Array.isArray(body) || Object.keys(body).length !== 0))) {
        reply.code(400).send({ error: { code: 'invalid_request' } })
        return
      }
      done()
    },
  }, async (request, reply) => {
    const bearer = /^Bearer +([A-Za-z0-9\-._~+/]+=*)$/i.exec(request.headers.authorization ?? '')
    if (!bearer) {
      return reply.code(401).send({ error: { code: 'invalid_credential' } })
    }

    try {
      const identity = await options.tokenValidator(bearer[1])
      if (!identity.authenticated || !identity.audienceMatches) {
        return reply.code(401).send({ error: { code: 'invalid_credential' } })
      }

      const role = identity.serviceAccount
      if (identity.namespace !== 'agents' || (role !== 'planner' && role !== 'coder')) {
        return reply.code(403).send({ error: { code: 'assignment_denied' } })
      }

      const pod = await options.podLookup({
        namespace: identity.namespace,
        podName: identity.podName,
      })
      if (pod.uid !== identity.podUid || pod.serviceAccount !== role) {
        return reply.code(403).send({ error: { code: 'assignment_denied' } })
      }

      const repository = pod.annotations['ai-native-sdlc/repository']
      if (!repository || !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository)
        || !Object.hasOwn(options.repositories, repository)) {
        return reply.code(403).send({ error: { code: 'assignment_denied' } })
      }

      const assignment = options.repositories[repository]
      const issued = await options.tokenIssuer({
        repositoryId: assignment.repositoryId,
        installationId: assignment.installationId,
        permissions: { ...permissionsByRole[role] },
      })
      return reply.header('Cache-Control', 'no-store').send({
        token: issued.token,
        expiresAt: issued.expiresAt,
      })
    } catch {
      // Upstream errors can contain credentials; do not pass them to the logger or reply.
      return reply.code(503).send({ error: { code: 'dependency_unavailable' } })
    }
  })
}

export default githubTokenRoute
