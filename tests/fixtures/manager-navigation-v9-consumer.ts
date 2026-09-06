import { CORDISX_SURFACE_CONTRIBUTION_SCHEMA_V9, type CordisXSlots } from 'cordisx/contracts'

declare const slots: CordisXSlots

slots.register({
  $schema: CORDISX_SURFACE_CONTRIBUTION_SCHEMA_V9,
  schemaVersion: 9,
  name: 'manager.settings.navigation-items',
  id: 'manage-chat',
  group: 'after-settings',
  order: 100,
}, {
  route: { id: 'manage-chat' },
  navigationGroup: { id: 'collaboration' },
})

slots.register({
  $schema: CORDISX_SURFACE_CONTRIBUTION_SCHEMA_V9,
  schemaVersion: 9,
  name: 'manager.settings.navigation-items',
  id: 'team-architecture',
  group: 'after-settings',
  order: 200,
}, {
  route: { id: 'team-architecture' },
  navigationGroup: { id: 'collaboration' },
})

slots.register({
  $schema: CORDISX_SURFACE_CONTRIBUTION_SCHEMA_V9,
  schemaVersion: 9,
  name: 'manager.settings.navigation-items',
  id: 'talent-market',
  group: 'after-settings',
  order: 300,
}, {
  route: { id: 'talent-market' },
  navigationGroup: { id: 'resources' },
})

slots.register({
  name: 'manager.settings.navigation-items',
  id: 'legacy-manager-page',
  group: 'before-settings',
}, { route: { id: 'legacy-manager-page' } })
