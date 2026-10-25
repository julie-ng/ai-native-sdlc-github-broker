import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`server uses configured address and closes on ${signal}`, { timeout: 10000 }, async (t) => {
    const server = spawn(process.execPath, ['src/server.js'], {
      env: { ...process.env, HOST: '127.0.0.1', PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const exited = once(server, 'exit')
    t.after(() => {
      if (server.exitCode === null && server.signalCode === null) {
        server.kill('SIGKILL')
      }
    })

    let output = ''
    const address = await new Promise((resolve, reject) => {
      server.on('error', reject)
      server.stderr.on('data', chunk => { output += chunk })
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
    assert.equal(response.status, 200)

    server.kill(signal)
    assert.deepEqual(await exited, [0, null], output)
    await assert.rejects(fetch(`${address}/healthz`))
  })
}
