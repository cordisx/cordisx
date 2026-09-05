import {
  CORDISX_PLUGIN_BUNDLE_MANAGER_SNAPSHOT_SCHEMA_V1,
  type CordisXPluginBundleManagerItemV1,
  type CordisXPluginBundleManagerSnapshotV1,
} from '../plugin-bundle-contracts.js'

const pluginDigest = `sha256:${'b'.repeat(64)}` as const
const permissionId = `permission:${'c'.repeat(64)}`

export function playgroundPluginBundleSnapshot(generation: string): CordisXPluginBundleManagerSnapshotV1 {
  const bundleIds = ['workflow-essentials', 'team-governance'] as const
  const shared = (
    id: typeof bundleIds[number],
    name: string,
    policy: 'allow' | 'deny',
  ): CordisXPluginBundleManagerItemV1 => ({
    id,
    name,
    description: id === 'workflow-essentials'
      ? 'A visual fixture for the Host-owned plugin bundle Manager.'
      : 'Shares one exact member with Workflow Essentials.',
    version: '1.0.0',
    digest: `sha256:${id === 'workflow-essentials' ? 'a'.repeat(64) : 'd'.repeat(64)}`,
    authors: ['CordisX'],
    sourceLabel: `${id}.bundle`,
    canonicalSource: `https://cordisx.dev/plugin-bundles/${id}`,
    installedAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    status: 'permission-blocked',
    enabled: true,
    readme:
      `# ${name}\n\nThis Playground fixture demonstrates the bundle README tab. Metadata and actions remain above the tabs.`,
    availableOperations: ['update', 'disable', 'uninstall'],
    members: [{
      pluginId: 'shared-notes',
      name: 'Shared Notes',
      requestedVersion: '1.0.0',
      installedVersion: '1.0.0',
      installedDigest: pluginDigest,
      required: true,
      enabledByDefault: true,
      enabled: true,
      state: 'shared',
      installedViaBundle: true,
      bundleIds,
      directClaim: false,
      runtimeDependentIds: ['workflow-runner'],
    }],
    permissions: [{
      permissionId,
      pluginId: 'shared-notes',
      capability: 'models.read',
      scopeLabel: '{}',
      required: true,
      bundlePolicy: policy,
      effectivePolicy: 'deny',
      effectiveSource: 'shared-bundle-merge',
      affectedBundleIds: bundleIds,
    }],
    claims: [
      ...bundleIds.map(bundleId => ({ pluginId: 'shared-notes', kind: 'bundle' as const, claimantId: bundleId })),
      { pluginId: 'shared-notes', kind: 'runtime-dependency', claimantId: 'workflow-runner' },
    ],
    dependencies: [{ pluginId: 'workflow-runner', dependencyId: 'shared-notes', version: '1.0.0' }],
    records: [{
      recordId: `${id}-install`,
      at: '2026-09-02T00:00:00.000Z',
      kind: 'install',
      outcome: 'applied',
      message: `Installed ${name}.`,
      pluginIds: ['shared-notes'],
    }],
  })
  return {
    $schema: CORDISX_PLUGIN_BUNDLE_MANAGER_SNAPSHOT_SCHEMA_V1,
    schemaVersion: 1,
    profileId: 'playground',
    revision: 2,
    pluginRevision: 4,
    runtimeGeneration: generation,
    operationsAvailable: false,
    bundles: [
      shared('workflow-essentials', 'Workflow Essentials', 'allow'),
      shared('team-governance', 'Team Governance', 'deny'),
    ],
  }
}
