import { createHash } from 'node:crypto';

// Server-authored binding. Hash the encrypted token, never store/log plaintext.
export function maxTarget(integration: any) {
  return {
    integrationId: integration.id,
    internalId: integration.internalId,
    providerConfigId: integration.providerConfigId ?? null,
    version: integration.providerVersion ?? 'v1',
    tokenHash: createHash('sha256').update(integration.token).digest('hex'),
  };
}
export function sameMaxTarget(a: any, b: any) {
  return !!a && Object.keys(b).every((key) => a[key] === b[key]);
}
