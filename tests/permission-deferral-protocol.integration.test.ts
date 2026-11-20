import { readdir, readFile } from 'node:fs/promises'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { expect, it } from 'vitest'
import { buildDeferredPermissionPlan, deferValidatedV1PermissionPlan } from '../packages/cli/src/permission-deferral.js'
import { bundleDeferredDecision } from '../packages/cli/src/launcher/plugin-bundle-deferred.js'
import { CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V1 } from '../packages/cli/src/platform-contracts.js'

it('emits plans and decisions accepted by the formally pinned protocol schemas', async () => {
  const directory = new URL('../node_modules/@cordisx/protocol/schemas/', import.meta.url)
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true })
  addFormats(ajv)
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.schema.json'))) {
    ajv.addSchema(JSON.parse(await readFile(new URL(name, directory), 'utf8')))
  }
  const source = 'file:///plugin'
  const binding = { operationId: 'install-example', runtimeGeneration: 'runtime', requestId: 'candidate' }
  const modern = buildDeferredPermissionPlan({
    planId: 'install-example',
    operation: 'install',
    profileId: 'test',
    identity: { source, pluginId: 'example' },
    binding,
    declarations: [{ name: 'models.read', required: false, scope: {} }],
    policiesV2: [],
    policiesV4: [],
  })
  const legacy = deferValidatedV1PermissionPlan({
    $schema: CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V1,
    schemaVersion: 1,
    planId: 'install-example',
    operation: 'install',
    profileId: 'test',
    identity: { source, pluginId: 'example' },
    defaultDecision: 'allow',
    declarations: [{
      capability: 'models.read',
      required: false,
      reason: { key: 'reason', fallback: 'List models' },
      scope: {},
      policy: 'ask',
      decisionRequired: true,
    }],
  }, binding)
  for (const plan of [modern, legacy]) {
    const validatePlan = ajv.getSchema(plan.$schema)!
    expect(validatePlan(plan), JSON.stringify(validatePlan.errors)).toBe(true)
    const { decision, selections } = bundleDeferredDecision(plan, () => 'allow')
    const pending = {
      ...plan,
      declarations: plan.declarations.map(item => ({
        ...item,
        authorizationMode: 'explicit-user',
        decisionRequired: true,
        reviewIntent: 'bundle-policy',
      })),
    }
    expect(validatePlan(pending), JSON.stringify(validatePlan.errors)).toBe(true)
    expect(selections).toEqual({ 'models.read': 'allow' })
    const validateDecision = ajv.getSchema(decision.$schema)!
    expect(validateDecision(decision), JSON.stringify(validateDecision.errors)).toBe(true)
  }
})
