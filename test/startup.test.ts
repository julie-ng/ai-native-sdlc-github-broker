import { writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { expect, test } from 'vitest'
import { startupEnvironment } from './startup-fixture.js'

const failures: Record<string, string | undefined>[] = [
  { GH_REPOSITORIES: undefined },
  { GH_REPOSITORIES: 'secret-marker-invalid-json' },
  { GH_REPOSITORIES: '{}' },
  { GH_REPOSITORIES: '[]' },
  { GH_REPOSITORIES: '{"example/repo":{"repositoryId":"secret-marker","installationId":2}}' },
  { GH_REPOSITORIES: '{"example/repo":{"repositoryId":1,"installationId":0}}' },
  { GH_REPOSITORIES: '{"invalid":{"repositoryId":1,"installationId":2}}' },
  { GH_APP_ID: undefined },
  { GH_APP_ID: 'secret-marker' },
  { GH_APP_PRIVATE_KEY_PATH: undefined },
  { GH_APP_PRIVATE_KEY_PATH: '/secret-marker/missing.pem' },
  { KUBERNETES_API_URL: 'http://secret-marker' },
]

for (const [index, overrides] of failures.entries()) {
  test(`invalid startup configuration ${index} exits without exposing values`, ({ onTestFinished }) => {
    const fixture = startupEnvironment()
    onTestFinished(fixture.cleanup)
    const result = spawnSync(process.execPath, ['dist/server.js'], {
      env: {
        ...process.env,
        ...fixture.env,
        ...overrides,
      },
      encoding: 'utf8',
      timeout: 5000,
    })
    expect(result.status).toBe(1)
    expect(result.stderr.trim()).not.toBe('')
    expect(result.stdout + result.stderr).not.toMatch(/secret-marker|BEGIN.*PRIVATE KEY|Server listening/)
  })
}

test('invalid private key content is never included in startup errors', ({ onTestFinished }) => {
  const fixture = startupEnvironment()
  onTestFinished(fixture.cleanup)
  writeFileSync(fixture.env.GH_APP_PRIVATE_KEY_PATH, 'secret-marker-invalid-private-key')
  const result = spawnSync(process.execPath, ['dist/server.js'], {
    env: {
      ...process.env,
      ...fixture.env,
    },
    encoding: 'utf8',
    timeout: 5000,
  })
  expect(result.status).toBe(1)
  expect(result.stderr.trim()).toBe('Private key is invalid')
  expect(result.stdout + result.stderr).not.toContain('secret-marker')
})
