import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@postmill-ai/nestjs-libraries/inngest/inngest.client', () => ({
  inngest: { createFunction: vi.fn() },
}));

import { inngest } from '@postmill-ai/nestjs-libraries/inngest/inngest.client';
import { createEditorialDeliverySweep } from './editorial-delivery-sweep';
import { captureFunctionHandler, createMockStep } from '../test/step.mock';

describe('test-only editorial delivery cron', () => {
  const activity = { sweep: vi.fn() };
  const runs = {
    recordStart: vi.fn(), recordComplete: vi.fn(), recordFailed: vi.fn(),
  };
  let handler: () => any;

  beforeEach(() => {
    vi.clearAllMocks();
    activity.sweep.mockResolvedValue({ status: 'disabled' });
    runs.recordStart.mockResolvedValue('2026-11-22T00:00:00.000Z');
    runs.recordComplete.mockResolvedValue(undefined);
    runs.recordFailed.mockResolvedValue(undefined);
    handler = captureFunctionHandler(vi.mocked(inngest.createFunction));
    createEditorialDeliverySweep(activity as any, runs as any);
  });

  it('registers one bounded UTC cron without MAX or AI triggers', () => {
    expect(inngest.createFunction).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'editorial-test-delivery-sweep',
        concurrency: 1,
        triggers: [{ cron: 'TZ=UTC */5 * * * *' }],
      }),
      expect.any(Function),
    );
  });

  it('invokes only the scoped activity and records cron health', async () => {
    const step = createMockStep();
    await handler()({ step });
    expect(step.run).toHaveBeenCalledWith('deliver-only-test-pending', expect.any(Function));
    expect(activity.sweep).toHaveBeenCalledTimes(1);
    expect(runs.recordStart).toHaveBeenCalledWith('editorial-test-delivery-sweep');
    expect(runs.recordComplete).toHaveBeenCalledTimes(1);
  });
});
