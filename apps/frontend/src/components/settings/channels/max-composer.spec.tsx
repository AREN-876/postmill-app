import { supportsMediaAttachments } from '../../composer/media-capabilities';
import { describe, expect, it, vi } from 'vitest';
const options = vi.hoisted(() => ({ value: null as any }));
vi.mock('@postmill-ai/frontend/components/media-tools/use-media-picker', () => ({
  // This test verifies composer metadata, not the heavyweight media modal.
  useMediaPicker: () => ({ open: () => {}, element: null }),
}));
vi.mock(
  '@postmill-ai/frontend/components/composer/providers/high.order.provider',
  () => ({
    PostComment: { POST: 'post' },
    withProvider: (value: unknown) => {
      options.value = value;
      return () => null;
    },
  }),
);
import MaxComposer from '../../composer/providers/max/max.provider';
describe('MAX composer', () => {
  it('preserves the first-part MAX limit and exposes story settings', () => {
    expect(supportsMediaAttachments('max')).toBe(false);
    expect(supportsMediaAttachments('telegram')).toBe(true);
    expect(supportsMediaAttachments()).toBe(true);
    expect(MaxComposer).toBeTypeOf('function');
    expect(options.value).toMatchObject({
      maximumCharacters: 4000,
      comments: false,
      postComment: 'post',
      SettingsComponent: expect.any(Function),
      dto: expect.any(Function),
    });
  });
});
