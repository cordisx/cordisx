import { isNpmRegistryPropagationError } from './npm-pack-report.mjs'
import { markRegistryPropagationError } from './registry-release-propagation.mjs'

function repositoryUrl(value) {
  return typeof value === 'string' ? value : value?.url
}

export function hasProvenance(metadata) {
  return typeof metadata?.dist?.attestations?.url === 'string'
    && typeof metadata.dist.attestations?.provenance?.predicateType === 'string'
}

export function assertImmutablePublishedMetadata({ pkg, manifest, packed, metadata, version, gitHead }) {
  if (metadata.version !== version) throw new Error(`${pkg.name} registry version mismatch`)
  if (metadata.dist?.integrity !== packed.integrity) {
    throw new Error(`${pkg.name} registry tarball integrity mismatch`)
  }
  if (metadata.gitHead !== gitHead) throw new Error(`${pkg.name} registry gitHead mismatch`)
  if (metadata.license !== manifest.license) throw new Error(`${pkg.name} registry license mismatch`)
  if (repositoryUrl(metadata.repository) !== manifest.repository.url) {
    throw new Error(`${pkg.name} registry repository mismatch`)
  }
  if (JSON.stringify(metadata.bin) !== JSON.stringify(manifest.bin)) {
    throw new Error(`${pkg.name} registry bin mismatch`)
  }
  if (JSON.stringify(metadata.engines) !== JSON.stringify(manifest.engines)) {
    throw new Error(`${pkg.name} registry engines mismatch`)
  }
}

export function assertReleaseTag(pkg, tags, { version, distTag }) {
  if (distTag !== 'latest' && tags.latest === version) {
    throw new Error(`${pkg.name} prerelease must not move latest`)
  }
  if (tags[distTag] !== version) {
    throw markRegistryPropagationError(
      new Error(`${pkg.name} ${distTag} dist-tag does not point to ${version}`),
      'verification',
    )
  }
}

export function isAlreadyPublishedError(error) {
  const output = `${error?.npmOutput ?? ''}\n${error?.commandOutput ?? ''}\n${error?.message ?? ''}`
  return /EPUBLISHCONFLICT|cannot publish over (?:the )?previously published|previously published versions/i.test(
    output,
  )
}

async function verifyOne(pkg, context) {
  const metadata = await context.viewVersion(pkg.name, context.version)
  if (metadata === undefined) {
    throw markRegistryPropagationError(
      new Error(`${pkg.name}@${context.version} is not visible yet`),
      'visibility',
    )
  }
  assertImmutablePublishedMetadata({
    pkg,
    manifest: context.manifests.get(pkg.name),
    packed: context.packs.get(pkg.name),
    metadata,
    version: context.version,
    gitHead: context.gitHead,
  })
  if (!hasProvenance(metadata)) {
    throw markRegistryPropagationError(
      new Error(`${pkg.name}@${context.version} provenance is not visible yet`),
      'verification',
    )
  }
  await context.assertRegistryPackage(pkg)
  const tags = await context.viewTags(pkg.name)
  assertReleaseTag(pkg, tags, context)
  return { name: pkg.name, latest: tags.latest }
}

async function verifyAll(packages, context) {
  const results = await Promise.allSettled(packages.map(pkg => verifyOne(pkg, context)))
  const fatal = results.find(result => result.status === 'rejected' && !isNpmRegistryPropagationError(result.reason))
  if (fatal?.status === 'rejected') throw fatal.reason
  const pendingResults = results.filter(result => result.status === 'rejected')
  const pending = results.flatMap((result, index) => result.status === 'rejected' ? [packages[index].name] : [])
  if (pending.length > 0) {
    context.log(`[registry] pending package readback: ${pending.join(', ')}`)
    const phase = pendingResults.some(result => result.reason?.releasePhase === 'visibility')
      ? 'visibility'
      : 'verification'
    throw markRegistryPropagationError(new Error(`pending packages: ${pending.join(', ')}`), phase)
  }
  return results.map(result => result.value)
}

export async function publishReleasePackages(options) {
  const {
    packages,
    manifests,
    packs,
    version,
    distTag,
    gitHead,
    viewVersion,
    viewTags,
    assertRegistryPackage,
    publish,
    retry,
    uploadedPackages = [],
    startAction = 'upload',
    progress = async () => undefined,
    log = console.log,
  } = options
  const context = {
    manifests,
    packs,
    version,
    distTag,
    gitHead,
    viewVersion,
    viewTags,
    assertRegistryPackage,
    log,
  }
  const submitted = new Set(uploadedPackages)
  const missing = []

  const uploadEnabled = startAction === 'upload'
  if (!['upload', 'visibility', 'verification'].includes(startAction)) {
    throw new Error(`unsupported publication recovery action: ${startAction}`)
  }
  await progress({ nextAction: startAction, attempt: 0, uploadedPackages: [...submitted] })

  for (const pkg of packages) {
    const metadata = await viewVersion(pkg.name, version)
    if (metadata === undefined) {
      if (uploadEnabled) missing.push(pkg)
      continue
    }
    assertImmutablePublishedMetadata({
      pkg,
      manifest: manifests.get(pkg.name),
      packed: packs.get(pkg.name),
      metadata,
      version,
      gitHead,
    })
    submitted.add(pkg.name)
    await progress({ nextAction: startAction, attempt: 0, uploadedPackages: [...submitted] })
    log(`[release] ${pkg.name}@${version} already matches immutable metadata; skipping publish`)
  }

  for (const pkg of missing) {
    try {
      await publish(pkg)
      log(`[release] submitted ${pkg.name}@${version} with ${distTag}`)
    } catch (error) {
      if (!isAlreadyPublishedError(error)) throw error
      log(`[release] ${pkg.name}@${version} was already submitted; waiting for registry readback`)
    }
    submitted.add(pkg.name)
    await progress({ nextAction: 'upload', attempt: 0, uploadedPackages: [...submitted] })
  }

  await progress({
    nextAction: startAction === 'verification' ? 'verification' : 'visibility',
    attempt: 0,
    uploadedPackages: [...submitted],
  })
  const published = await retry('published package metadata', async attempt => {
    await progress({
      nextAction: startAction === 'verification' ? 'verification' : 'visibility',
      attempt,
      uploadedPackages: [...submitted],
    })
    try {
      return await verifyAll(packages, context)
    } catch (error) {
      await progress({
        nextAction: error?.releasePhase ?? 'visibility',
        attempt,
        uploadedPackages: [...submitted],
      })
      throw error
    }
  })
  await progress({ nextAction: 'clean-install', attempt: 0, uploadedPackages: [...submitted] })
  return published
}
