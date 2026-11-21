/**
 * The EDITORIAL TEST session route is opt-in at Nest bootstrap.
 *
 * Neither this parser nor the UI feature flag is authorization. The HTTP
 * controller also enforces cookie auth + CSRF + explicit org RBAC; its SQL
 * reads only signed, frozen editorial DRAFTs whose bound MAX target matches.
 *
 * The machine transport is NOT mounted here. It still requires a separately
 * qualified private loopback listener and HMAC credential lifecycle.
 */
import type { EditorialHumanReviewConfig } from '@postmill-ai/backend/services/editorial/editorial-human-review.service';
import type { EditorialReleaseConfig } from '@postmill-ai/backend/services/editorial/editorial-release.service';

// A fixed TEST target — no editable MAX channel name, wildcard, or arbitrary
// "max:" identifier can enable an operator-facing release.
export const EDITORIAL_TEST_MAX_TARGET = 'max:-73052031470103' as const;

type Environment = Readonly<Record<string, string | undefined>>;
const ORG = /^[A-Za-z0-9_.:-]{1,200}$/;

export function editorialSessionConfig(
  env: Environment,
): EditorialHumanReviewConfig | null {
  if (env.EDITORIAL_TEST_SESSION_ENABLED !== 'true' ||
      typeof env.EDITORIAL_TEST_ORG_ID !== 'string' ||
      !ORG.test(env.EDITORIAL_TEST_ORG_ID) ||
      env.EDITORIAL_TEST_MAX_TARGET !== EDITORIAL_TEST_MAX_TARGET) {
    return null;
  }
  return {
    enabled: true,
    testOrgId: env.EDITORIAL_TEST_ORG_ID,
    targetInternalId: EDITORIAL_TEST_MAX_TARGET,
  };
}

export function editorialReleaseConfig(
  env: Environment,
): EditorialReleaseConfig | null {
  if (env.EDITORIAL_TEST_RELEASE_ENABLED !== 'true') return null;
  // Release cannot become active separately from session review. It also
  // cannot be enabled for any other org or MAX target.
  return editorialSessionConfig(env);
}

export function editorialSessionRoutesEnabled(env: Environment): boolean {
  return editorialSessionConfig(env) !== null;
}
