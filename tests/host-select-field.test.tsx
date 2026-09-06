import React, { useState } from 'react'
import { describe, expect, it } from 'vitest'
let SelectField: typeof import('../packages/cli/src/renderer/host-ui/SelectField.js').SelectField
import { reactManagerFixture } from './helpers/react-manager.js'

function Filter() {
  const [value, setValue] = useState('all')
  return (
    <SelectField
      label="API / type"
      icon="filter"
      value={value}
      onChange={setValue}
      options={[{ value: 'all', label: 'All' }, { value: 'console', label: 'console' }]}
    />
  )
}

describe('Host SelectField accessibility and official popup', () => {
  it('labels the actual input and changes its controlled value through a real option click', async () => {
    const fixture = reactManagerFixture()
    try {
      ;({ SelectField } = await import('../packages/cli/src/renderer/host-ui/SelectField.js'))
      await fixture.render(<Filter />)
      const input = fixture.element('input[aria-label="API / type"]') as HTMLInputElement
      expect(input.value).toBe('All')
      await fixture.choose('input[aria-label="API / type"]', 'console')
      expect(input.value).toBe('console')
    } finally {
      await fixture.dispose()
    }
    expect(fixture.document.querySelector('.t-select__dropdown')).toBeNull()
  })
})
