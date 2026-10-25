import Fastify, { type FastifyServerOptions } from 'fastify'

export function buildApp(options: FastifyServerOptions = {}) {
  const app = Fastify(options)

  app.get('/healthz', async () => ({ status: 'ok' }))

  return app
}
