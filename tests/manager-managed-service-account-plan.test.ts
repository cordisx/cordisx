import { expect, it } from 'vitest'
import { managedAccountToggleBorrowPolicy } from '../packages/cli/src/cli/manager-managed-service-account-plan.js'

it('freezes exact service operations, values and limits for an owner action', () => {
  const plan = {
    operations: [
      { operationId: 'accounts.list', maxInvocations: 2 },
      { operationId: 'accounts.toggle', value: { name: 'one', disabled: true }, maxInvocations: 1 },
    ],
  }
  const policy = managedAccountToggleBorrowPolicy(plan, () => true)
  plan.operations[1]!.value!.name = 'other'
  expect(policy.operations).toEqual(['accounts.list', 'accounts.toggle'])
  expect(policy.limits).toEqual({ 'accounts.list': 2, 'accounts.toggle': 1 })
  expect(policy.allows('accounts.list', undefined)).toBe(true)
  expect(policy.allows('accounts.toggle', { name: 'one', disabled: true })).toBe(true)
  expect(policy.allows('accounts.toggle', { name: 'other', disabled: true })).toBe(false)
  expect(policy.allows('accounts.toggle', { name: 'one', disabled: false })).toBe(false)
  expect(policy.allows('accounts.delete', undefined)).toBe(false)
})

it.each([
  { operations: [] },
  { operations: [{ operationId: 'bad id', maxInvocations: 1 }] },
  { operations: [{ operationId: 'one', maxInvocations: 0 }] },
  { operations: [{ operationId: 'one', maxInvocations: 17 }, { operationId: 'two', maxInvocations: 16 }] },
  { operations: [{ operationId: 'one', maxInvocations: 1 }, { operationId: 'one', maxInvocations: 1 }] },
  { operations: [{ operationId: 'one', maxInvocations: 1, value: { token: 'not allowed' } }] },
  { operations: [{ operationId: 'one', maxInvocations: 1, value: Number.NaN }] },
  { operations: [{ operationId: 'one', maxInvocations: 1, value: { nested: undefined } }] },
])('rejects invalid or secret-bearing action plans', plan => {
  expect(() => managedAccountToggleBorrowPolicy(plan, () => true)).toThrow('managed-account-toggle-plan-unavailable')
})
