import Fastify from 'fastify'

export function buildApp(options = {}) {
  const app = Fastify(options)

  app.get('/healthz', async () => ({ status: 'ok' }))

  return app
}
