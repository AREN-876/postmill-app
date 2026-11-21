import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EDITORIAL_TEST_MAX_TARGET,
  editorialReleaseConfig,
  editorialSessionConfig,
  editorialSessionRoutesEnabled,
} from './editorial-session-runtime';

const valid = Object.freeze({
  EDITORIAL_TEST_SESSION_ENABLED: 'true',
  EDITORIAL_TEST_ORG_ID: 'org-safe-01',
  EDITORIAL_TEST_MAX_TARGET: EDITORIAL_TEST_MAX_TARGET,
});
const released = { ...valid, EDITORIAL_TEST_RELEASE_ENABLED: 'true' };

describe('Editorial 11 — closed-by-default test-org runtime activation', () => {
  it('registers no routes with unset, false or malformed session opt-in', () => {
    const bad = [
      {}, { ...valid, EDITORIAL_TEST_SESSION_ENABLED: 'false' },
      { ...valid, EDITORIAL_TEST_SESSION_ENABLED: 'TRUE' },
      { ...valid, EDITORIAL_TEST_ORG_ID: '' },
      { ...valid, EDITORIAL_TEST_ORG_ID: 'a'.repeat(201) },
      { ...valid, EDITORIAL_TEST_ORG_ID: 'org-id;DROP TABLE' },
      { ...valid, EDITORIAL_TEST_MAX_TARGET: '' },
      { ...valid, EDITORIAL_TEST_MAX_TARGET: 'max:-123' },
      { ...valid, EDITORIAL_TEST_MAX_TARGET: 'My chanel2' },
      { ...released, EDITORIAL_TEST_SESSION_ENABLED: 'false' },
    ];
    for (const env of bad) {
      expect(editorialSessionRoutesEnabled(env)).toBe(false);
      expect(editorialSessionConfig(env)).toBeNull();
      expect(editorialReleaseConfig(env)).toBeNull();
    }
  });

  it('explicit review-only opt-in does not authorize any release', () => {
    expect(editorialSessionRoutesEnabled(valid)).toBe(true);
    expect(editorialSessionConfig(valid)).toEqual({
      enabled: true,
      testOrgId: 'org-safe-01',
      targetInternalId: EDITORIAL_TEST_MAX_TARGET,
    });
    expect(editorialReleaseConfig(valid)).toBeNull();
  });

  it('release flag is a second positive gate and cannot widen org/target', () => {
    expect(editorialReleaseConfig(released)).toEqual(editorialSessionConfig(valid));
    expect(editorialReleaseConfig({
      ...released, EDITORIAL_TEST_MAX_TARGET: 'max:-different',
    })).toBeNull();
    expect(editorialReleaseConfig({
      EDITORIAL_TEST_RELEASE_ENABLED: 'true',
    })).toBeNull();
  });

  it('never imports machine receiver into production AppModule', () => {
    const app = fs.readFileSync(path.resolve(__dirname, '../app.module.ts'), 'utf8');
    const mod = fs.readFileSync(path.resolve(__dirname, './editorial-human-review.module.ts'), 'utf8');
    expect(app).toContain('editorialSessionRoutesEnabled(process.env)');
    expect(app).toContain('? [EditorialHumanReviewModule]');
    expect(app).not.toContain('EditorialExchangeModule');
    expect(mod).toContain('consumer.apply(AuthMiddleware).forRoutes(...authenticatedController)');
    expect(mod).toContain('consumer.apply(CsrfMiddleware).forRoutes(...authenticatedController)');
    expect(mod).not.toContain('EDITORIAL_EXCHANGE_CONFIG');
  });
});
