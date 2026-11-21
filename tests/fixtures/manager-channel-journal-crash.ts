import { LauncherSecretStore } from '../../packages/cli/src/launcher/secret-store.js'
import { ManagerChannelDraftJournal } from '../../packages/cli/src/launcher/manager-channel-draft-journal.js'

const homeDir = process.env.CORDISX_FIXTURE_HOME!
const configPath = process.env.CORDISX_FIXTURE_CONFIG!
const store = new LauncherSecretStore({ homeDir, platform: 'linux' })
const journal = new ManagerChannelDraftJournal({ homeDir, configPath, profileId: 'work', store })
const capture = store.beginCapture({
  profileId: 'work',
  connectionId: 'draft-0123456789abcdef0123456789abcdef01234567',
})
const reference = store.referenceFor(capture.captureId)!
await journal.record(reference)
await store.capture({ captureId: capture.captureId, secret: 'synthetic-secret' })
// Simulate termination before any in-memory cleanup.
process.exit(17)
