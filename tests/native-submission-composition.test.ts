import { describe, expect, it } from 'vitest'

import { nativeSubmissionTransformsForApp } from '../packages/cli/src/launcher/native-submission-composition.js'
import { NATIVE_OPERATION_REQUEST_TRANSFORM } from '../packages/cli/src/renderer/adapter/native-operation-request-transform.js'
import { NATIVE_OPERATION_REQUEST_TRANSFORM_9275 } from '../packages/cli/src/renderer/adapter/native-operation-request-transform.js'
import { NATIVE_SUBMIT_ORCHESTRATOR_TRANSFORM } from '../packages/cli/src/renderer/adapter/native-submit-orchestrator-transform.js'
import {
  NATIVE_SUBMIT_ORCHESTRATOR_TRANSFORM_BUILD_9275,
} from '../packages/cli/src/renderer/adapter/native-submit-orchestrator-transform.js'

describe('native submission composition', () => {
  it('selects transforms only for the exact audited Desktop app identity', () => {
    expect(nativeSubmissionTransformsForApp('26.901.51231', '8109')).toEqual([
      NATIVE_SUBMIT_ORCHESTRATOR_TRANSFORM,
      NATIVE_OPERATION_REQUEST_TRANSFORM,
    ])
    expect(nativeSubmissionTransformsForApp('26.908.70816', '9275')).toEqual([
      NATIVE_SUBMIT_ORCHESTRATOR_TRANSFORM_BUILD_9275,
      NATIVE_OPERATION_REQUEST_TRANSFORM_9275,
    ])
    expect(nativeSubmissionTransformsForApp('26.908.70816', '8109')).toBeUndefined()
    expect(nativeSubmissionTransformsForApp('future', '9275')).toBeUndefined()
  })
})
