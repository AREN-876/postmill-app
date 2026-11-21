import { describe, expect, it } from 'vitest';
import { canShowEditorialReviewInPostDetail as visible } from './editorial-entry.guard';

const post = {
  id: 'a'.repeat(32),
  state: 'DRAFT',
  editorialTaskId: '804',
};
const channel = { providerIdentifier: 'max', internalId: 'max:-73052031470103' };
const target = 'max:-73052031470103';

describe('Editorial 10: dormant review entry in existing Postmill details', () => {
  it('remains invisible without explicit two-part build-time opt-in', () => {
    expect(visible(post, channel, undefined, target)).toBe(false);
    expect(visible(post, channel, 'false', target)).toBe(false);
    expect(visible(post, channel, 'true', undefined)).toBe(false);
    expect(visible(post, channel, 'true', '')).toBe(false);
    expect(visible(post, channel, 'TRUE', target)).toBe(false);
  });

  it('matches the immutable MAX target, not the editable channel name', () => {
    expect(visible(post, { ...channel, name: 'renamed' }, 'true', target))
      .toBe(true);
    expect(visible(post, { ...channel, internalId: 'max:-999' }, 'true', target))
      .toBe(false);
    expect(visible(post, { ...channel, providerIdentifier: 'telegram' }, 'true', target))
      .toBe(false);
    expect(visible(post, channel, 'true', 'max:-999')).toBe(false);
    expect(visible(post, channel, 'true', 'http://unsafe')).toBe(false);
  });

  it('never exposes review for old published, queued or regular draft posts', () => {
    expect(visible({ ...post, state: 'PUBLISHED' }, channel, 'true', target)).toBe(false);
    expect(visible({ ...post, state: 'QUEUE' }, channel, 'true', target)).toBe(false);
    expect(visible({ ...post, editorialTaskId: null }, channel, 'true', target)).toBe(false);
    expect(visible({ ...post, id: 'not-an-id' }, channel, 'true', target)).toBe(false);
    expect(visible({ ...post, editorialTaskId: '9223372036854775808' }, channel, 'true', target))
      .toBe(false);
    expect(visible(null, channel, 'true', target)).toBe(false);
  });
});
