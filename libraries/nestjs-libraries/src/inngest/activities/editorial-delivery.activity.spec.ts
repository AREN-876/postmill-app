import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({ readFileSync: vi.fn() }));
import { readFileSync } from 'node:fs';
import { EditorialDeliveryActivity } from './editorial-delivery.activity';

const eventId = '11111111-2222-4333-8444-555555555555';
const scope = {
  org_id: 'test-org', is_test: true, integration_id: 'max-channel',
  campaign_id: 'campaign', channel_id: '4', profile_ref: 'stories@v1',
  image_mode: 'disabled',
};
const pending = {
  schema_version: 1, org_id: scope.org_id, task_id: '5', event_id: eventId,
  payload_sha256: 'f'.repeat(64),
  dispatch_authorized: false, publishable: false,
  event: {
    schema_version: 1, event_id: eventId, producer: 'postmill',
    binding: { org_id: scope.org_id, task_id: '5', is_test: true },
  },
};

describe('editorial test-only send-once activity', () => {
  const posts = {
    listPendingEditorialTestDelivery: vi.fn(),
    readPendingEditorialDelivery: vi.fn(),
    reserveEditorialSubmit: vi.fn(),
  };
  const delivery = { deliverReserved: vi.fn() };
  const activity = new EditorialDeliveryActivity(posts as any, delivery as any);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('EDITORIAL_TEST_DELIVERY_ENABLED', 'true');
    vi.stubEnv('EDITORIAL_TEST_SESSION_ENABLED', 'true');
    vi.stubEnv('EDITORIAL_TEST_ORG_ID', scope.org_id);
    vi.stubEnv('EDITORIAL_TEST_MAX_TARGET', 'max:-73052031470103');
    vi.mocked(readFileSync).mockImplementation((p) =>
      String(p).includes('request') ? 'a'.repeat(64) : 'b'.repeat(64),
    );
    posts.listPendingEditorialTestDelivery.mockResolvedValue([{ task: '5', scope }]);
    posts.readPendingEditorialDelivery.mockResolvedValue(pending);
    posts.reserveEditorialSubmit.mockResolvedValue({ event_id: eventId, newly_reserved: true });
    delivery.deliverReserved.mockResolvedValue({ status: 'recorded' });
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('is inert when test gate is disabled', async () => {
    vi.stubEnv('EDITORIAL_TEST_DELIVERY_ENABLED', 'false');
    await expect(activity.sweep()).resolves.toEqual({ status: 'disabled' });
    expect(posts.listPendingEditorialTestDelivery).not.toHaveBeenCalled();
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it('commits reservation before exactly one signed submit', async () => {
    const result = await activity.sweep();
    expect(result).toMatchObject({ submitted: 1, confirmed: 1, lookedUp: 0 });
    expect(posts.reserveEditorialSubmit).toHaveBeenCalledWith(
      scope, '5', 'max:-73052031470103', eventId,
    );
    expect(delivery.deliverReserved).toHaveBeenCalledWith(
      scope, '5', 'max:-73052031470103', expect.objectContaining({ orgId: scope.org_id }),
      eventId, 'submit',
    );
    expect(posts.reserveEditorialSubmit.mock.invocationCallOrder[0])
      .toBeLessThan(delivery.deliverReserved.mock.invocationCallOrder[0]);
  });

  it('never submits a second time after unknown network outcome', async () => {
    delivery.deliverReserved.mockRejectedValueOnce(new Error('uncertain'));
    await expect(activity.sweep()).rejects.toThrow('uncertain');
    posts.reserveEditorialSubmit.mockResolvedValue({ event_id: eventId, newly_reserved: false });
    delivery.deliverReserved.mockResolvedValueOnce({ status: 'unknown' });
    const result = await activity.sweep();
    expect(result).toMatchObject({ submitted: 0, lookedUp: 1, unknown: 1 });
    expect(delivery.deliverReserved.mock.calls.map((args: unknown[]) => args[5]))
      .toEqual(['submit', 'lookup']);
  });

  it('refuses unbound candidates and malformed reservations', async () => {
    posts.listPendingEditorialTestDelivery.mockResolvedValueOnce([
      { task: '5', scope: { ...scope, org_id: 'other' } },
    ]);
    await expect(activity.sweep()).rejects.toThrow('editorial_delivery_scope_mismatch');
    expect(posts.reserveEditorialSubmit).not.toHaveBeenCalled();

    posts.reserveEditorialSubmit.mockResolvedValueOnce({
      event_id: 'changed', newly_reserved: true,
    });
    await expect(activity.sweep()).rejects.toThrow('editorial_delivery_reservation_unknown');
    expect(delivery.deliverReserved).not.toHaveBeenCalled();
  });
});
