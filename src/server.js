import { buildApp } from './app.js'

const app = buildApp({
  logger: {
    redact: ['req.headers.authorization'],
  },
})

async function shutdown() {
  try {
    await app.close()
  }
  catch (error) {
    app.log.error(error)
    process.exitCode = 1
  }
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

try {
  await app.listen({
    host: process.env.HOST ?? '127.0.0.1',
    port: Number(process.env.PORT ?? 3000),
  })
}
catch (error) {
  app.log.error(error)
  process.exitCode = 1
}
