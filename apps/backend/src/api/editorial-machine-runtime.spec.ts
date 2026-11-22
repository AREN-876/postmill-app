import { describe, expect, it } from 'vitest';
import { EDITORIAL_TEST_MAX_TARGET, editorialReleaseConfig } from './editorial-session-runtime';
import { editorialMachineConfig, editorialMachineRoutesEnabled } from './editorial-machine-runtime';

const valid = Object.freeze({
  EDITORIAL_TEST_MACHINE_ENABLED: 'true',
  EDITORIAL_TEST_MAX_TARGET: EDITORIAL_TEST_MAX_TARGET,
  EDITORIAL_TEST_ORG_ID: 'org-test-01',
  EDITORIAL_TEST_INTEGRATION_ID: 'integration-01',
  EDITORIAL_TEST_CAMPAIGN_ID: 'campaign-01',
  EDITORIAL_TEST_CHANNEL_ID: '4',
  EDITORIAL_TEST_PROFILE_REF: 'life-stories-terra-test@v1',
  EDITORIAL_TEST_IMAGE_MODE: 'disabled',
  EDITORIAL_TEST_MACHINE_TOKEN_SHA256: 'a'.repeat(64),
  EDITORIAL_TEST_MACHINE_EXPIRES_AT: '2099-01-01T00:00:00.000Z',
});

describe('Editorial 13 — machine ingress default-off test-channel gate', () => {
  it('rejects absent or partial configuration, wrong target and paid image modes', () => {
    const invalid = [
      {},
      { ...valid, EDITORIAL_TEST_MACHINE_ENABLED: 'false' },
      { ...valid, EDITORIAL_TEST_MACHINE_ENABLED: 'TRUE' },
      { ...valid, EDITORIAL_TEST_MACHINE_ENABLED: undefined },
      { ...valid, EDITORIAL_TEST_ORG_ID: '' },
      { ...valid, EDITORIAL_TEST_ORG_ID: 'org;DROP TABLE' },
      { ...valid, EDITORIAL_TEST_INTEGRATION_ID: '' },
      { ...valid, EDITORIAL_TEST_INTEGRATION_ID: 'fixture:fake' },
      { ...valid, EDITORIAL_TEST_CAMPAIGN_ID: undefined },
      { ...valid, EDITORIAL_TEST_CHANNEL_ID: '0' },
      { ...valid, EDITORIAL_TEST_CHANNEL_ID: '9223372036854775808' },
      { ...valid, EDITORIAL_TEST_PROFILE_REF: 'invalid' },
      { ...valid, EDITORIAL_TEST_IMAGE_MODE: 'automatic' },
      { ...valid, EDITORIAL_TEST_IMAGE_MODE: 'manual' },
      { ...valid, EDITORIAL_TEST_MAX_TARGET: 'max:-123' },
      { ...valid, EDITORIAL_TEST_MAX_TARGET: 'My chanel2' },
      { ...valid, EDITORIAL_TEST_MACHINE_TOKEN_SHA256: '' },
      { ...valid, EDITORIAL_TEST_MACHINE_TOKEN_SHA256: 'A'.repeat(64) },
      { ...valid, EDITORIAL_TEST_MACHINE_EXPIRES_AT: '2025-01-01T00:00:00.000Z' },
      { ...valid, EDITORIAL_TEST_MACHINE_EXPIRES_AT: '2099-01-01' },
      { ...valid, EDITORIAL_TEST_MACHINE_EXPIRES_AT: '2099-02-30T00:00:00.000Z' },
    ];
    for (const env of invalid) {
      expect(editorialMachineConfig(env, Date.UTC(2026, 10, 22))).toBeNull();
      expect(editorialMachineRoutesEnabled(env)).toBe(false);
    }
  });

  it('binds only the exact test org, integration, campaign and channel', () => {
    expect(editorialMachineConfig(valid, Date.UTC(2026, 10, 22))).toEqual({
      targetInternalId: EDITORIAL_TEST_MAX_TARGET,
      credential: {
        org_id: 'org-test-01',
        integration_id: 'integration-01',
        campaign_id: 'campaign-01',
        channel_id: '4',
        profile_ref: 'life-stories-terra-test@v1',
        is_test: true,
        image_mode: 'disabled',
        token_sha256: 'a'.repeat(64),
        expires_at: '2099-01-01T00:00:00.000Z',
      },
    });
    expect(editorialMachineRoutesEnabled(valid)).toBe(true);
  });

  it('keeps human review and publication independently disabled', () => {
    expect(editorialReleaseConfig(valid)).toBeNull();
    expect(editorialReleaseConfig({ ...valid, EDITORIAL_TEST_RELEASE_ENABLED: 'true' })).toBeNull();
    expect(editorialMachineConfig(valid, Date.UTC(2099, 0, 1))).toBeNull();
  });
});
