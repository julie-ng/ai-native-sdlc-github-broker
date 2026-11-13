import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function startupEnvironment() {
  const directory = mkdtempSync(join(tmpdir(), 'broker-startup-'))
  const keyPath = join(directory, 'app.pem')
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  writeFileSync(keyPath, privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  }))
  return {
    env: {
      GITHUB_APP_ID: '123',
      GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
      GITHUB_REPOSITORIES: JSON.stringify({
        'example/repo': {
          repositoryId: 1,
          installationId: 2,
        },
      }),
    },
    cleanup: () => rmSync(directory, {
      recursive: true,
      force: true,
    }),
  }
}
