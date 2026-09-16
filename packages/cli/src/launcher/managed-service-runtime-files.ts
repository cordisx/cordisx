import { createHash } from 'node:crypto'
import { chmod } from 'node:fs/promises'
import path from 'node:path'
import { managedServiceResourceMatchesTarget } from './managed-service-package-resources.js'
import type { ManagedServiceRecord } from './managed-service-runtime-record.js'
import { managedContainedFile, readManagedContainedFile } from './managed-service-runtime-support.js'

const EXECUTABLE_MODE = 0o500

export function assertManagedServiceEnvironmentBindings(record: ManagedServiceRecord): void {
  const reserved = new Set(process.platform === 'win32' ? ['HOME', 'USERPROFILE'] : ['HOME'])
  if (
    record.definition.protectedBindings.some(binding =>
      binding.target === 'environment' && reserved.has(binding.variable)
    )
  ) throw new Error('managed service environment binding targets a Host-owned variable')
}

export async function resolveManagedServiceEnvironment(record: ManagedServiceRecord): Promise<void> {
  const reserved = new Set(process.platform === 'win32' ? ['HOME', 'USERPROFILE'] : ['HOME'])
  assertManagedServiceEnvironmentBindings(record)
  const seen = new Set<string>()
  for (const declaration of record.definition.environment ?? []) {
    if (seen.has(declaration.variable) || reserved.has(declaration.variable)) {
      throw new Error('managed service environment declaration is invalid')
    }
    seen.add(declaration.variable)
    if (
      record.definition.protectedBindings.some(binding =>
        binding.target === 'environment' && binding.variable === declaration.variable
      )
    ) {
      throw new Error('managed service environment declaration is invalid')
    }
    const value = declaration.source === 'literal'
      ? declaration.value
      : await managedContainedFile(record.serviceHome, declaration.path)
    if (value.includes('\u0000')) throw new Error('managed service environment declaration is invalid')
    record.environment[declaration.variable] = value
  }
}

export function declaredManagedRuntimeResource(
  record: ManagedServiceRecord,
  relative: `./${string}`,
  mode?: 'executable' | 'data',
) {
  const declarations = record.access.runtimeResources
    ?? record.access.declaration.runtimeResources.filter(resource => managedServiceResourceMatchesTarget(resource))
  const declaration = declarations
    .find(resource => resource.path === relative)
  if (declaration === undefined || (mode !== undefined && declaration.mode !== mode)) {
    throw new Error('managed service file is undeclared')
  }
  return declaration
}

export async function readManagedRuntimeResource(
  record: ManagedServiceRecord,
  relative: `./${string}`,
  mode?: 'executable' | 'data',
  maxBytes?: number,
): Promise<Buffer> {
  const declaration = declaredManagedRuntimeResource(record, relative, mode)
  if (maxBytes !== undefined && declaration.byteLength > maxBytes) {
    throw new Error('managed service file exceeds its use-site bound')
  }
  const bytes = await readManagedContainedFile(record.access.artifactDirectory, relative, declaration.byteLength)
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const
  if (bytes.byteLength !== declaration.byteLength || digest !== declaration.digest) {
    throw new Error('managed service file failed integrity readback')
  }
  return bytes
}

export async function resolveManagedRuntimeResource(
  record: ManagedServiceRecord,
  relative: `./${string}`,
  mode?: 'executable' | 'data',
): Promise<string> {
  const declaration = declaredManagedRuntimeResource(record, relative, mode)
  await readManagedRuntimeResource(record, relative, mode)
  const file = path.join(record.access.artifactDirectory, relative.slice(2))
  if (declaration.mode === 'executable' && process.platform !== 'win32') await chmod(file, EXECUTABLE_MODE)
  return file
}
