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

function errorResponse(code: string, description: string) {
  return {
    description,
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        required: ['code'],
        properties: {
          code: {
            type: 'string',
            enum: [code],
          },
        },
      },
    },
    example: { error: { code } },
  }
}

const githubTokenRoute: FastifyPluginAsync<TokenExchangeOptions> = async (app, options) => {
  app.post('/v1/github-token', {
    schema: {
      operationId: 'exchangeGithubToken',
      summary: 'Exchange a pod credential for a scoped GitHub token',
      description: 'Authenticate using Authorization: Bearer <projected Kubernetes token> with audience token-broker. '
        + 'The reviewed pod UID and ServiceAccount must match the looked-up pod in namespace agents. '
        + 'Its ai-native-sdlc/repository annotation selects an allowlisted owner/repo. '
        + 'Planner permissions are contents: read and issues: read; coder permissions are contents: write, '
        + 'pull_requests: write and issues: read. No caller-supplied scope or query string is accepted. '
        + 'Omit the body and JSON content type, or send {} as application/json. An empty body with a JSON content type returns 400. '
        + 'A successful response includes Cache-Control: no-store; expiresAt comes directly from the issuer.',
      tags: ['Tokens'],
      security: [{ podBearer: [] }],
      body: {
        description: 'Optional empty JSON object. Repository, role, installation and permissions are selected server-side.',
        type: 'object',
        additionalProperties: false,
        properties: {},
        example: {},
      },
      response: {
        200: {
          description: 'Scoped GitHub installation token. Cache-Control: no-store.',
          type: 'object',
          required: ['token', 'expiresAt'],
          properties: {
            token: {
              type: 'string',
              description: 'Short-lived GitHub installation token.',
            },
            expiresAt: {
              type: 'string',
              format: 'date-time',
              description: 'Issuer-provided ISO 8601 expiry.',
            },
          },
          example: {
            token: 'ghs_example',
            expiresAt: '2026-11-13T12:00:00Z',
          },
        },
        400: errorResponse('invalid_request', 'Query string, extra body fields, malformed input or unsupported content type.'),
        401: errorResponse('invalid_credential', 'Missing or malformed bearer token, failed review or wrong audience.'),
        403: errorResponse('assignment_denied', 'Unknown namespace or ServiceAccount, pod UID/ServiceAccount mismatch, or missing/malformed/unapproved repository annotation.'),
        503: errorResponse('dependency_unavailable', 'Token review, pod lookup or issuer failed. No fallback credential or upstream details are returned.'),
      },
    },
    // preValidation remains authoritative: AJV would reject an absent optional body.
    // It also must not strip or coerce fields before the existing rejection checks.
    validatorCompiler: () => () => true,
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
