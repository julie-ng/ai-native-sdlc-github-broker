import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import githubTokenRoute from './routes/v1/github-token.post.js'
import type { TokenExchangeOptions } from './token-exchange.types.js'

export function buildApp(options: FastifyServerOptions = {}, tokenExchange?: TokenExchangeOptions) {
  const app = Fastify(options)
  registerAppRoutes(app, tokenExchange)
  return app
}

// Shared with the offline generator, which registers Swagger before these routes.
export function registerAppRoutes(app: FastifyInstance, tokenExchange?: TokenExchangeOptions) {
  app.get('/healthz', {
    schema: {
      operationId: 'getHealth',
      summary: 'Check process liveness',
      description: 'Returns process liveness only. Does not check Kubernetes, GitHub or Key Vault readiness.',
      tags: ['Health'],
      response: {
        200: {
          description: 'The broker process is alive.',
          type: 'object',
          required: ['status'],
          properties: {
            status: {
              type: 'string',
              enum: ['ok'],
            },
          },
          example: { status: 'ok' },
        },
      },
    },
  }, async () => ({ status: 'ok' }))

  // Real adapters and server configuration are wired in separate issues.
  if (tokenExchange) {
    app.register(githubTokenRoute, tokenExchange)
  }
}
