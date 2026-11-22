/**
 * Explicit, default-off machine DRAFT ingress for the operator-confirmed test MAX channel.
 *
 * This is only route registration and an exact trusted admission scope.
 * The bearer secret itself is never stored here or in the Postmill environment:
 * only SHA-256 of the dedicated edx_v1_... secret is configured.
 * Release, publication, Editorial sender/receiver and paid work are NOT activated.
 */
import type { ExchangeConfiguration } from '@postmill-ai/nestjs-libraries/database/prisma/posts/editorial-exchange.service';
import { EDITORIAL_TEST_MAX_TARGET } from './editorial-session-runtime';

type Environment = Readonly<Record<string, string | undefined>>;
const ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const CHANNEL = /^[1-9][0-9]{0,18}$/;
const PROFILE = /^[a-z][a-z0-9_-]{0,63}@v[1-9][0-9]{0,8}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function editorialMachineConfig(
  env: Environment,
  now = Date.now(),
): ExchangeConfiguration | null {
  const {
    EDITORIAL_TEST_MACHINE_ENABLED: enabled,
    EDITORIAL_TEST_MAX_TARGET: target,
    EDITORIAL_TEST_ORG_ID: org,
    EDITORIAL_TEST_INTEGRATION_ID: integration,
    EDITORIAL_TEST_CAMPAIGN_ID: campaign,
    EDITORIAL_TEST_CHANNEL_ID: channel,
    EDITORIAL_TEST_PROFILE_REF: profile,
    EDITORIAL_TEST_IMAGE_MODE: imageMode,
    EDITORIAL_TEST_MACHINE_TOKEN_SHA256: digest,
    EDITORIAL_TEST_MACHINE_EXPIRES_AT: expires,
  } = env;

  if (enabled !== 'true' || target !== EDITORIAL_TEST_MAX_TARGET ||
      !org || !ID.test(org) ||
      !integration || !ID.test(integration) || integration.startsWith('fixture:') ||
      !campaign || !ID.test(campaign) ||
      !channel || !CHANNEL.test(channel) ||
      (channel.length === 19 && channel > '9223372036854775807') ||
      !profile || !PROFILE.test(profile) ||
      imageMode !== 'disabled' ||
      !digest || !SHA256.test(digest) ||
      !expires || !ISO_UTC.test(expires) ||
      !Number.isFinite(now)) {
    return null;
  }

  const expiry = Date.parse(expires);
  if (!Number.isFinite(expiry) || new Date(expiry).toISOString() !== expires || expiry <= now) {
    return null;
  }

  return {
    credential: {
      org_id: org,
      integration_id: integration,
      campaign_id: campaign,
      channel_id: channel,
      profile_ref: profile,
      is_test: true,
      image_mode: 'disabled',
      token_sha256: digest,
      expires_at: expires,
    },
    targetInternalId: EDITORIAL_TEST_MAX_TARGET,
  };
}

export function editorialMachineRoutesEnabled(env: Environment): boolean {
  return editorialMachineConfig(env) !== null;
}
