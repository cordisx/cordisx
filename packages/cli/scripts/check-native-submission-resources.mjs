import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { extractFile } from '@electron/asar'
import { nativeSubmissionTransformsForApp } from '../dist/src/launcher/native-submission-composition.js'
import { readNativeSubmissionResources } from '../dist/src/launcher/native-app-resources.js'
import { discoverNativeAccountCapability } from '../dist/src/launcher/native-account-structure.js'

const { values } = parseArgs({ options: { app: { type: 'string' }, 'resources-dir': { type: 'string' } } })
if (Boolean(values.app) === Boolean(values['resources-dir'])) {
  throw new Error('Specify exactly one of --app or --resources-dir')
}
let identity = { appVersion: 'unknown (resource directory)', buildNumber: 'unknown' }
let resources
if (values.app) {
  const contents = path.join(values.app, 'Contents')
  const manifest = JSON.parse(extractFile(path.join(contents, 'Resources/app.asar'), 'package.json').toString())
  identity = { appVersion: manifest.version, buildNumber: manifest.codexBuildNumber }
  resources = readNativeSubmissionResources(contents)
} else {
  const root = values['resources-dir']
  const files = (await readdir(root)).filter(file => /^app-(?:initial|primary)-(?!transformed)[^.]+\.js$/u.test(file))
  resources = await Promise.all(
    files.map(async file => ({ url: `app://-/assets/${file}`, source: await readFile(path.join(root, file), 'utf8') })),
  )
}
const transforms = nativeSubmissionTransformsForApp(identity.appVersion, identity.buildNumber, resources)
const result = transforms.map(transform => {
  const input = resources.find(resource => resource.url === transform.url)
  const transformed = transform.transform(input.source)
  return { url: transform.url, sha256: transform.sha256, anchorMatches: transformed.anchorMatches }
})
const initial = resources.find(resource => resource.url.includes('/app-initial-'))
let accountCapability
try {
  accountCapability = discoverNativeAccountCapability(initial)
} catch (error) {
  accountCapability = { unavailable: error.message }
}
console.log(
  JSON.stringify(
    {
      evidence: 'read-only resource compatibility, not native end-to-end',
      ...identity,
      resources: result,
      accountCapability,
    },
    null,
    2,
  ),
)
