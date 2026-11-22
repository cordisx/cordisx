import { nonEmptyString, record, rejectUnknownKeys } from './home-config-values.js'

/** Registered publisher verification keys are Host-local, never catalog metadata. */
export interface HomeConfigPublisherGrantIssuer {
  readonly id: string
  readonly keyId: string
  readonly environment: 'sandbox' | 'live'
  /** Ed25519 SubjectPublicKeyInfo DER, base64url encoded. */
  readonly publicKeySpki: string
}

export function parsePublisherGrantIssuer(value: unknown, index: number): HomeConfigPublisherGrantIssuer {
  const label = `config.publisherGrantIssuers[${index}]`
  const issuer = record(value, label)
  rejectUnknownKeys(issuer, ['id', 'keyId', 'environment', 'publicKeySpki'], label)
  const id = nonEmptyString(issuer.id, `${label}.id`)
  const keyId = nonEmptyString(issuer.keyId, `${label}.keyId`)
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id)) throw new Error(`${label}.id is invalid`)
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(keyId)) throw new Error(`${label}.keyId is invalid`)
  if (issuer.environment !== 'sandbox' && issuer.environment !== 'live') {
    throw new Error(`${label}.environment is invalid`)
  }
  const publicKeySpki = nonEmptyString(issuer.publicKeySpki, `${label}.publicKeySpki`)
  if (!/^[A-Za-z0-9_-]+$/.test(publicKeySpki)) throw new Error(`${label}.publicKeySpki must be base64url`)
  return { id, keyId, environment: issuer.environment, publicKeySpki }
}
