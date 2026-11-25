import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { loadManagerDeploymentConfig } from '../packages/cli/src/cli/manager-deployment-config.js'

it('expands configured console origins and listener ranges for a LAN or remote deployment', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cx-manager-deployment-'))
  try {
    const file = path.join(directory, 'manager.json')
    await writeFile(
      file,
      JSON.stringify({
        publicOrigin: 'https://manager.example.test:8443/',
        consoleOrigins: { template: 'https://{view}.console.example.test:{port}', firstPort: 8444 },
        listeners: [
          { host: '0.0.0.0', port: 8443 },
          { host: '0.0.0.0', firstPort: 8444, count: 2 },
        ],
        tls: { certificateFile: 'cert.pem', privateKeyFile: 'key.pem' },
      }),
    )
    await writeFile(path.join(directory, 'cert.pem'), 'fixture certificate')
    await writeFile(path.join(directory, 'key.pem'), 'fixture private key')
    const first = await loadManagerDeploymentConfig(file, 2)
    expect(first.publicOrigin).toBe('https://manager.example.test:8443')
    expect(first.publicConsoleOriginTemplates).toEqual([
      'https://{view}.console.example.test:8444',
      'https://{view}.console.example.test:8445',
    ])
    expect(first.listeners.map(listener => listener.port)).toEqual([8443, 8444, 8445])
    expect(first.listeners.every(listener => !!listener.tls)).toBe(true)
    await writeFile(path.join(directory, 'key.pem'), 'rotated fixture private key')
    expect((await loadManagerDeploymentConfig(file, 2)).revision).not.toBe(first.revision)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('accepts named console origins behind a user-provided reverse proxy', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cx-manager-deployment-'))
  try {
    const file = path.join(directory, 'manager.json')
    await writeFile(
      file,
      JSON.stringify({
        publicOrigin: 'https://manager.example.test',
        consoleOrigins: { template: 'https://{view}.console-{slot}.example.test' },
        listeners: [{ host: '127.0.0.1', port: 9000 }],
      }),
    )
    const config = await loadManagerDeploymentConfig(file, 2)
    expect(config.publicConsoleOriginTemplates).toEqual([
      'https://{view}.console-1.example.test',
      'https://{view}.console-2.example.test',
    ])
    expect(config.listeners[0]!.tls).toBeUndefined()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('rejects fixed console origins, invalid port ranges and unexpected configuration fields', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cx-manager-deployment-'))
  try {
    const file = path.join(directory, 'manager.json')
    for (
      const value of [
        {
          publicOrigin: 'https://manager.example.test',
          consoleOrigins: ['https://manager.example.test'],
          listeners: [],
        },
        {
          publicOrigin: 'https://manager.example.test',
          listeners: [{ host: '127.0.0.1', firstPort: 65535, count: 2 }],
        },
        { publicOrigin: 'https://manager.example.test', listeners: [{ host: '127.0.0.1', port: 9000 }], extra: true },
      ]
    ) {
      await writeFile(file, JSON.stringify(value))
      await expect(loadManagerDeploymentConfig(file, 1)).rejects.toThrow()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
