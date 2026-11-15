import { PROVIDER_CAPABILITIES } from '@postmill-ai/provider-kernel/domains/social-capabilities';

export function supportsMediaAttachments(identifier?: string): boolean {
  return PROVIDER_CAPABILITIES[identifier || '']?.maxMedia !== 0;
}
