import { buildApp } from './app.js'

const HOST = process.env.HOST || '127.0.0.1'
const PORT = Number(process.env.PORT || 3000)

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
    host: HOST,
    port: PORT,
  })
}
catch (error) {
  app.log.error(error)
  process.exitCode = 1
}
