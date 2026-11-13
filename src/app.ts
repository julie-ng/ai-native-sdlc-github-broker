import Fastify, { type FastifyServerOptions } from 'fastify'
import githubTokenRoute from './routes/v1/github-token.post.js'
import type { TokenExchangeOptions } from './token-exchange.types.js'

export function buildApp(options: FastifyServerOptions = {}, tokenExchange?: TokenExchangeOptions) {
  const app = Fastify(options)

  app.get('/healthz', async () => ({ status: 'ok' }))

  // Real adapters and server configuration are wired in separate issues.
  if (tokenExchange) {
    app.register(githubTokenRoute, tokenExchange)
  }

  return app
}
