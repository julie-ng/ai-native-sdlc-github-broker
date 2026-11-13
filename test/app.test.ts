import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { expect, test } from 'vitest'
import { startupEnvironment } from './startup-fixture.js'

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`server uses configured address and closes on ${signal}`, { timeout: 10000 }, async ({ onTestFinished }) => {
    const fixture = startupEnvironment()
    onTestFinished(fixture.cleanup)
    const server = spawn(process.execPath, ['dist/server.js'], {
      env: {
        ...process.env,
        ...fixture.env,
        HOST: '127.0.0.1',
        PORT: '0',
      },
      stdio: [
        'ignore',
        'pipe',
        'pipe',
      ],
    })
    const exited = once(server, 'exit')
    onTestFinished(() => {
      if (server.exitCode === null && server.signalCode === null) {
        server.kill('SIGKILL')
      }
    })

    let output = ''
    const address = await new Promise<string>((resolve, reject) => {
      server.on('error', reject)
      server.stderr.on('data', chunk => {
        output += chunk
      })
      server.once('exit', () => reject(new Error(`Server exited before listening: ${output}`)))
      server.stdout.on('data', (chunk) => {
        output += chunk
        const match = output.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/)
        if (match) {
          resolve(match[1])
        }
      })
    })

    const response = await fetch(`${address}/healthz`)
    await response.text()
    expect(response.status).toBe(200)

    const exchange = await fetch(`${address}/v1/github-token`, { method: 'POST' })
    expect(exchange.status).toBe(401)

    server.kill(signal)
    expect(await exited, output).toEqual([0, null])
    await expect(fetch(`${address}/healthz`)).rejects.toThrow()
  })
}
