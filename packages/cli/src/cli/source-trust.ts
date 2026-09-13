import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  provisionManagedSource,
  registerManagedSourceOwner,
  revokeManagedSource,
} from '../launcher/managed-source-trust.js'
export async function runSourceTrust(argv: readonly string[], homeDir: string, stdout: (value: string) => void) {
  if (argv.length !== 3 || !['provision', 'register-owner', 'revoke'].includes(argv[1] ?? '') || !argv[2]) {
    throw new Error('Usage: cordisx source-trust <provision|register-owner|revoke> <managed-source-request.json>')
  }
  const raw = await readFile(path.resolve(argv[2]), 'utf8')
  if (Buffer.byteLength(raw) > 8192) throw new Error('managed source request too large')
  const input = JSON.parse(raw) as Parameters<typeof provisionManagedSource>[0] & {
    existingOwner?: Parameters<typeof registerManagedSourceOwner>[0]['existingOwner']
  }
  if (
    !input || Object.keys(input).some(key =>
      !(argv[1] === 'register-owner'
        ? ['profileId', 'binding', 'owner', 'existingOwner']
        : argv[1] === 'provision'
        ? ['profileId', 'binding', 'owner', 'serverDirectory']
        : ['profileId', 'binding', 'owner']).includes(key)
    )
    || (argv[1] === 'provision'
      && (typeof input.serverDirectory !== 'string' || !path.isAbsolute(input.serverDirectory)))
  ) throw new Error('invalid managed source request')
  if (argv[1] === 'register-owner') {
    if (!input.existingOwner) throw new Error('existingOwner is required')
    const result = await registerManagedSourceOwner({ ...input, existingOwner: input.existingOwner, homeDir })
    stdout(`[cordisx] managed source owner registered: ${result.registry}`)
    return
  }
  if (argv[1] === 'revoke') {
    const result = await revokeManagedSource({ ...input, homeDir })
    stdout(`[cordisx] managed source trust revoked: ${result.registry}`)
    return
  }
  const result = await provisionManagedSource({ ...input, homeDir })
  stdout(`[cordisx] managed source registry: ${result.registry}`)
  stdout(`[cordisx] private server trust: ${result.serverTrust}`)
}
