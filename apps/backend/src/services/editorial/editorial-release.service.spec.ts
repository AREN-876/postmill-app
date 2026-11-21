import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorialReleaseService } from './editorial-release.service';

const orgId = 'ci-org';
const userId = 'ci-editor';
const postId = 'a'.repeat(32);
const taskId = '804';
const commandId = '11111111-1111-4111-8111-111111111111';
const publicationId = 'b'.repeat(32);
const cmd = { command_id: commandId, action: 'publish_now' as const, publish_at: null };
const release = {
  created: true, source_post_id: postId, publication_post_id: publicationId,
  mode: 'publish_now', provider_version: 'v1', publish_at: '2026-11-21T10:00:00.000Z',
};

describe('Editorial 09B explicit release — default disabled, no duplicates', () => {
  const posts = {
    readEditorialHuman: vi.fn(),
    readEditorialRelease: vi.fn(),
    releaseEditorialStory: vi.fn(),
  };
  const postService = {
    previewEditorialStorySlot: vi.fn(),
    startWorkflow: vi.fn(),
  };
  const roles = { getEffectivePermissions: vi.fn() };
  const audit = { record: vi.fn() };
  let service: EditorialReleaseService;

  beforeEach(() => {
    vi.resetAllMocks();
    roles.getEffectivePermissions.mockResolvedValue({ permissions: ['posts:read', 'posts:update'] });
    posts.releaseEditorialStory.mockResolvedValue(release);
    posts.readEditorialRelease.mockResolvedValue(null);
    posts.readEditorialHuman.mockResolvedValue({
      review_acknowledged: true,
      receipt: { image_mode: 'disabled', binding: { integration_id: 'integration-test' } },
      review: { status: 'idle', last_confirmed_state: {
        final_approved: true, rejected: false,
        text_status: 'approved', image_mode: 'disabled',
      } },
    });
    postService.previewEditorialStorySlot.mockResolvedValue({
      integrationId: 'integration-test',
      timezone: 'Europe/Moscow',
      localTime: '2026-11-22 08:00',
      publishAt: '2026-11-22T05:00:00.000Z',
    });
    postService.startWorkflow.mockResolvedValue(undefined);
    audit.record.mockResolvedValue(undefined);
    service = new EditorialReleaseService(
      posts as never, postService as never, roles as never, audit as never,
      { enabled: true, testOrgId: orgId, targetInternalId: 'max:-999' },
    );
  });

  it('does not allow even a preview or release in production default-disabled configuration', async () => {
    const off = new EditorialReleaseService(
      posts as never, postService as never, roles as never, audit as never, null,
    );
    await expect(off.preview(orgId, userId, postId, taskId)).rejects.toMatchObject({ status: 404 });
    await expect(off.release(orgId, userId, postId, taskId, cmd))
      .rejects.toMatchObject({ status: 404 });
    expect(posts.releaseEditorialStory).not.toHaveBeenCalled();
    expect(postService.startWorkflow).not.toHaveBeenCalled();
  });

  it('one explicit publish-now click creates one native story and requests one worker workflow', async () => {
    const result = await service.release(orgId, userId, postId, taskId, cmd);
    expect(posts.releaseEditorialStory).toHaveBeenCalledExactlyOnceWith(
      orgId, postId, taskId, 'max:-999', userId, cmd,
    );
    expect(postService.startWorkflow).toHaveBeenCalledExactlyOnceWith(
      'max', publicationId, orgId, 'QUEUE', 'v1',
    );
    expect(result).toMatchObject({
      created: true, mode: 'publish_now',
      status: 'native_dispatch_requested', max_delivery_confirmed: false,
      publication_post_id: publicationId,
    });
  });

  it('a confirmed SQL replay never emits a second workflow event', async () => {
    posts.releaseEditorialStory.mockResolvedValueOnce({
      ...release, created: false,
    });
    const result = await service.release(orgId, userId, postId, taskId, cmd);
    expect(result.status).toBe('already_recorded');
    expect(postService.startWorkflow).not.toHaveBeenCalled();
  });

  it('queue command forwards one exact Moscow-grid UTC slot, not three different posts', async () => {
    const scheduled = { command_id: commandId, action: 'queue' as const,
      publish_at: '2026-11-22T05:00:00.000Z' };
    posts.releaseEditorialStory.mockResolvedValueOnce({
      ...release, mode: 'queue', created: true,
    });
    const result = await service.release(orgId, userId, postId, taskId, scheduled);
    expect(result.created).toBe(true);
    expect(posts.releaseEditorialStory).toHaveBeenCalledWith(
      orgId, postId, taskId, 'max:-999', userId, scheduled,
    );
    expect(postService.startWorkflow).toHaveBeenCalledTimes(1);
    expect(postService.startWorkflow.mock.calls[0][1]).toBe(publicationId);
  });

  it('read-only preview needs final approval, and reports one next whole-story slot', async () => {
    const result = await service.preview(orgId, userId, postId, taskId);
    expect(result).toMatchObject({
      ready: true, status: 'available',
      next_slot: { localTime: '2026-11-22 08:00', timezone: 'Europe/Moscow' },
    });
    expect(postService.previewEditorialStorySlot).toHaveBeenCalledWith(
      orgId, 'integration-test',
    );
    expect(postService.startWorkflow).not.toHaveBeenCalled();
    posts.readEditorialHuman.mockResolvedValueOnce({
      review_acknowledged: true, review: { status: 'pending' },
    });
    expect(await service.preview(orgId, userId, postId, taskId))
      .toMatchObject({ ready: false, status: 'not_finally_approved' });
  });

  it('rejects extra fields, invalid dates, unauthorized actors or foreign orgs before SQL', async () => {
    await expect(service.release(orgId, userId, postId, taskId,
      { ...cmd, actor_id: 'injected' })).rejects.toMatchObject({ status: 400 });
    await expect(service.release(orgId, userId, postId, taskId,
      { ...cmd, action: 'queue', publish_at: '2026-11-22T05:00:00+03:00' }))
      .rejects.toMatchObject({ status: 400 });
    roles.getEffectivePermissions.mockResolvedValueOnce({ permissions: ['posts:read'] });
    await expect(service.release(orgId, userId, postId, taskId, cmd))
      .rejects.toMatchObject({ status: 403 });
    await expect(service.release('other-org', userId, postId, taskId, cmd))
      .rejects.toMatchObject({ status: 404 });
    expect(posts.releaseEditorialStory).not.toHaveBeenCalled();
  });

  it('does not retry SQL or claim confirmed publication on an unknown database response', async () => {
    posts.releaseEditorialStory.mockRejectedValueOnce(new Error('unknown DB result'));
    await expect(service.release(orgId, userId, postId, taskId, cmd))
      .rejects.toMatchObject({ status: 503 });
    expect(posts.releaseEditorialStory).toHaveBeenCalledTimes(1);
    expect(postService.startWorkflow).not.toHaveBeenCalled();
  });
});
