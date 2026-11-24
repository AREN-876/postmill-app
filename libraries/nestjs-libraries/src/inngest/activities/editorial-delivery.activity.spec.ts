import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({ readFileSync: vi.fn() }));
import { readFileSync } from 'node:fs';
import { EditorialDeliveryActivity } from './editorial-delivery.activity';

const scope = {
  org_id: 'test-org', is_test: true, integration_id: 'max-channel',
  campaign_id: 'campaign', channel_id: '4', profile_ref: 'stories@v1',
  image_mode: 'disabled',
};

describe('editorial test-only delivery activity', () => {
  const posts = { listPendingEditorialTestDelivery: vi.fn(), listPendingEditorialTextRevisions: vi.fn() };
  const delivery = { deliverPending: vi.fn(), reconcileTextRevision: vi.fn() };
  const activity = new EditorialDeliveryActivity(posts as any, delivery as any);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('EDITORIAL_TEST_DELIVERY_ENABLED', 'true');
    vi.stubEnv('EDITORIAL_TEST_RECOVERY_ENABLED', 'false');
    vi.stubEnv('EDITORIAL_TEST_REVISION_SYNC_ENABLED', 'false');
    vi.stubEnv('EDITORIAL_TEST_SESSION_ENABLED', 'true');
    vi.stubEnv('EDITORIAL_TEST_ORG_ID', scope.org_id);
    vi.stubEnv('EDITORIAL_TEST_MAX_TARGET', 'max:-73052031470103');
    (vi.mocked(readFileSync) as any).mockImplementation((p: unknown) =>
      String(p).includes('request') ? 'a'.repeat(64) : 'b'.repeat(64),
    );
    posts.listPendingEditorialTestDelivery.mockResolvedValue([{ task: '5', scope }]);
    delivery.deliverPending.mockResolvedValue({ status: 'recorded', operation: 'submit' });
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('is inert when the test gate is disabled', async () => {
    vi.stubEnv('EDITORIAL_TEST_DELIVERY_ENABLED', 'false');
    await expect(activity.sweep()).resolves.toEqual({ status: 'disabled' });
    expect(posts.listPendingEditorialTestDelivery).not.toHaveBeenCalled();
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it('delegates one bounded test-org candidate to the reservation-owning service', async () => {
    const result = await activity.sweep();
    expect(result).toMatchObject({ submitted: 1, confirmed: 1, lookedUp: 0 });
    expect(delivery.deliverPending).toHaveBeenCalledTimes(1);
    expect(posts.listPendingEditorialTextRevisions).not.toHaveBeenCalled();
    expect(delivery.deliverPending).toHaveBeenCalledWith(
      scope, '5', 'max:-73052031470103',
      expect.objectContaining({ orgId: scope.org_id, allowMissingRecovery: false }),
    );
  });

  it('explicit opt-in is required for bounded recovery', async () => {
    vi.stubEnv('EDITORIAL_TEST_RECOVERY_ENABLED', 'true');
    await activity.sweep();
    expect(delivery.deliverPending).toHaveBeenCalledWith(scope, '5', 'max:-73052031470103',
      expect.objectContaining({ allowMissingRecovery: true }));
  });

  it('syncs revisions only with separate opt-in and preserves the exact return reference', async () => {
    vi.stubEnv('EDITORIAL_TEST_REVISION_SYNC_ENABLED', 'true');
    posts.listPendingEditorialTextRevisions.mockResolvedValue([{ task: '7', scope,
      eventId: 'request-id', digest: 'a'.repeat(64) }]);
    delivery.reconcileTextRevision.mockResolvedValue({ status: 'recorded' });
    await expect(activity.sweep()).resolves.toMatchObject({ revisionsRecorded: 1, revisionsWaiting: 0 });
    expect(delivery.reconcileTextRevision).toHaveBeenCalledWith(scope,'7','max:-73052031470103',
      'request-id','a'.repeat(64),expect.objectContaining({ orgId: scope.org_id }));
  });

  it('reflects lookup after uncertain outcome without passing a submit mode', async () => {
    delivery.deliverPending.mockRejectedValueOnce(new Error('uncertain'));
    await expect(activity.sweep()).rejects.toThrow('uncertain');
    delivery.deliverPending.mockResolvedValueOnce({ status: 'unknown', operation: 'lookup' });
    const result = await activity.sweep();
    expect(result).toMatchObject({ submitted: 0, lookedUp: 1, unknown: 1 });
    expect(delivery.deliverPending).toHaveBeenCalledTimes(2);
  });

  it('refuses cross-organization candidates before transport', async () => {
    posts.listPendingEditorialTestDelivery.mockResolvedValueOnce([
      { task: '5', scope: { ...scope, org_id: 'other' } },
    ]);
    await expect(activity.sweep()).rejects.toThrow('editorial_delivery_scope_mismatch');
    expect(delivery.deliverPending).not.toHaveBeenCalled();
  });
});
