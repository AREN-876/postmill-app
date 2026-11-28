import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { v5 as uuidv5 } from 'uuid';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

const sendMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@postmill-ai/nestjs-libraries/inngest/inngest.client', () => ({
  inngest: { send: (...args: any[]) => sendMock(...args) },
  isInngestEnabled: () => true,
}));

const safeFetchMock = vi.fn().mockResolvedValue({ status: 200 });
vi.mock('@postmill-ai/nestjs-libraries/dtos/webhooks/safe.fetch', () => ({
  safeFetch: (...args: any[]) => safeFetchMock(...args),
  webhookSignature: () => 'sha256=test',
  webhookTimeoutMs: () => 10000,
}));

import { PostActivity } from '@postmill-ai/nestjs-libraries/inngest/activities/post.activity';
import { XDto } from '@postmill-ai/provider-kernel/domains/social-dtos';

// Minimal constructor stub — the methods under test only touch a handful of deps.
const build = (over: Partial<Record<string, any>> = {}) => {
  const deps: any = {
    _postService: {},
    _notificationService: {},
    _integrationManager: {},
    _integrationService: {},
    _refreshIntegrationService: {},
    _webhookService: {},
    _subscriptionService: {},
    _orgProviderConfigService: {},
    _orgVpnConfigService: {},
    _vpnDispatcherService: {},
    _campaignsRepository: {},
    _postsRepository: { isDeleted: vi.fn().mockResolvedValue(false) },
    ...over,
  };
  deps._postService={ classifyEditorialLiveRelease:vi.fn().mockResolvedValue('ordinary'), ...deps._postService };
  const activity = new PostActivity(
    deps._postService,
    deps._notificationService,
    deps._integrationManager,
    deps._integrationService,
    deps._refreshIntegrationService,
    deps._webhookService,
    deps._subscriptionService,
    deps._orgProviderConfigService,
    deps._orgVpnConfigService,
    deps._vpnDispatcherService,
    deps._campaignsRepository,
    deps._postsRepository
  );
  return { activity, deps };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  delete process.env.STRIPE_PUBLISHABLE_KEY;
});

describe('PostActivity.claimForPublish (0.7)', () => {
  it('delegates to the repository and returns the count', async () => {
    const claimForPublish = vi.fn().mockResolvedValue(1);
    const { activity } = build({ _postsRepository: { claimForPublish } });

    const result = await activity.claimForPublish('post-1', 'org-1');

    expect(claimForPublish).toHaveBeenCalledWith('post-1', 'org-1');
    expect(result).toBe(1);
  });
});

describe('PostActivity.searchForMissingThreeHoursPosts recovery id (0.8)', () => {
  it('sends a unique-per-send recovery publish id (never a bare post_<id>)', async () => {
    const post = {
      id: 'p1',
      organizationId: 'org-1',
      integration: { providerIdentifier: 'x', providerVersion: null },
    };
    const { activity } = build({
      _postService: {
        resetStalePublishingToQueue: vi.fn().mockResolvedValue(0), pendingMaxOccurrences: vi.fn().mockResolvedValue([]),
        searchForMissingThreeHoursPosts: vi.fn().mockResolvedValue([post, post]),
      },
      _integrationManager: {
        getSocialIntegrationUnchecked: vi.fn().mockReturnValue({ maxConcurrentJob: 1 }),
      },
    });

    await activity.searchForMissingThreeHoursPosts();

    const publishIds = sendMock.mock.calls
      .filter((c) => c[0]?.name === 'post/publish')
      .map((c) => c[0].id);
    expect(publishIds).toHaveLength(2);
    for (const id of publishIds) {
      expect(id).toMatch(/^post_p1_recovery_/);
      expect(id).not.toBe('post_p1');
    }
    // unique per send
    expect(new Set(publishIds).size).toBe(2);
    // the post/cancel still precedes each publish
    expect(sendMock.mock.calls.filter((c) => c[0]?.name === 'post/cancel')).toHaveLength(2);
  });
});

describe('PostActivity.searchForMissingThreeHoursPosts PUBLISHING recovery (0.7 follow-up)', () => {
  it('resets stale PUBLISHING posts BEFORE querying for missing QUEUE posts', async () => {
    const order: string[] = [];
    const resetStalePublishingToQueue = vi
      .fn()
      .mockImplementation(async () => {
        order.push('reset');
        return 1;
      });
    const searchForMissingThreeHoursPosts = vi
      .fn()
      .mockImplementation(async () => {
        order.push('find');
        return [];
      });
    const { activity } = build({
      _postService: {
        resetStalePublishingToQueue, pendingMaxOccurrences: vi.fn().mockResolvedValue([]),
        searchForMissingThreeHoursPosts,
      },
    });

    await activity.searchForMissingThreeHoursPosts();

    // The reset must run first so a post orphaned in PUBLISHING is back to QUEUE by
    // the time the finder queries (finder matches QUEUE only), and is recovered this
    // same sweep rather than sitting stuck for another hour.
    expect(resetStalePublishingToQueue).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['reset', 'find']);
  });
});

describe('PostActivity.getPost null guard (4.4b)', () => {
  it('returns false when the post is missing instead of throwing', async () => {
    const { activity } = build({
      _postService: { getPostById: vi.fn().mockResolvedValue(null) },
    });

    await expect(activity.getPost('org-1', 'missing')).resolves.toBe(false);
  });
});

describe('slimPost via getPostsList (2.5)', () => {
  it('drops token/refreshToken/customInstanceDetails from the integration', async () => {
    const getPostsRecursively = vi.fn().mockResolvedValue([
      {
        id: 'p1',
        parentPostId: null,
        content: 'hi',
        integration: {
          id: 'int-1',
          organizationId: 'org-1',
          providerIdentifier: 'x',
          name: 'X',
          token: 'SECRET-TOKEN',
          refreshToken: 'SECRET-REFRESH',
          customInstanceDetails: 'SECRET-INSTANCE',
        },
      },
    ]);
    const { activity } = build({ _postService: { getPostsRecursively } });

    const [post] = await activity.getPostsList('org-1', 'p1');

    expect(post.integration).toBeDefined();
    expect(post.integration.token).toBeUndefined();
    expect(post.integration.refreshToken).toBeUndefined();
    expect(post.integration.customInstanceDetails).toBeUndefined();
    // non-secret fields preserved
    expect(post.integration.id).toBe('int-1');
    expect(post.integration.providerIdentifier).toBe('x');
  });
});

describe('MAX recovery isolation', () => {
  it('continues the ordinary sweep when the MAX journal is unavailable', async () => {
    const search = vi.fn().mockResolvedValue([]);
    const { activity } = build({ _postService: { resetStalePublishingToQueue: vi.fn(),
      pendingMaxOccurrences: vi.fn().mockRejectedValue(new Error('synthetic MAX journal failure')),
      searchForMissingThreeHoursPosts: search } });
    await activity.searchForMissingThreeHoursPosts();
    expect(search).toHaveBeenCalledTimes(1);
  });
});

describe('postSocial poll mapping + capability guard (2.2)', () => {
  const baseDeps = (post: any) => ({
    _postService: {
      updateTags: vi.fn().mockResolvedValue([post]),
      updateMedia: vi.fn().mockResolvedValue([]),
    },
    _integrationService: {
      getIntegrationById: vi.fn().mockResolvedValue({
        id: 'int-1',
        organizationId: 'org-1',
        providerIdentifier: 'x',
        internalId: 'ig-1',
        token: 'TOKEN',
      }),
    },
    _orgProviderConfigService: {
      getVpnSelectionForIntegration: vi.fn().mockResolvedValue(null),
    },
  });

  it('forwards poll.options to the adapter for a poll-capable provider (x)', async () => {
    const post = {
      id: 'p1',
      content: 'Vote',
      campaignId: null,
      image: '[]',
      settings: JSON.stringify({ poll: { options: ['a', 'b', 'c'], duration: 24 } }),
    };
    const postSpy = vi.fn().mockResolvedValue([{ postId: 'x1', id: 'p1' }]);
    const { activity } = build({
      ...baseDeps(post),
      _integrationManager: {
        getSocialIntegration: vi.fn().mockResolvedValue({
          editor: 'normal',
          post: postSpy,
        }),
        requireClientInformation: vi.fn().mockResolvedValue({}),
      },
    });

    await activity.postSocial(
      { id: 'int-1', organizationId: 'org-1', providerIdentifier: 'x' } as any,
      [post as any]
    );

    const payload = postSpy.mock.calls[0][2];
    expect(payload[0].poll).toEqual({ options: ['a', 'b', 'c'], duration: 24 });
  });

  it('throws (never publishes plain) when a poll is set on a non-poll provider', async () => {
    const post = {
      id: 'p1',
      content: 'Vote',
      campaignId: null,
      image: '[]',
      settings: JSON.stringify({ poll: { options: ['a', 'b'], duration: 24 } }),
    };
    const postSpy = vi.fn().mockResolvedValue([{ postId: 'm1', id: 'p1' }]);
    const { activity } = build({
      ...baseDeps(post),
      _integrationService: {
        getIntegrationById: vi.fn().mockResolvedValue({
          id: 'int-1',
          organizationId: 'org-1',
          providerIdentifier: 'mastodon',
          internalId: 'ig-1',
          token: 'TOKEN',
        }),
      },
      _integrationManager: {
        getSocialIntegration: vi.fn().mockResolvedValue({ editor: 'normal', post: postSpy }),
        requireClientInformation: vi.fn().mockResolvedValue({}),
      },
    });

    await expect(
      activity.postSocial(
        { id: 'int-1', organizationId: 'org-1', providerIdentifier: 'mastodon' } as any,
        [post as any]
      )
    ).rejects.toThrow(/does not support polls/);
    expect(postSpy).not.toHaveBeenCalled();
  });
});

describe('PostActivity managed draft fence', () => {
  it('does not touch provider dependencies for a managed draft', async () => {
    const getSocialIntegration = vi.fn();
    const { activity, deps } = build({ _integrationManager: { getSocialIntegration } });
    const result = await activity.postSocial(
      { providerIdentifier: 'max', organizationId: 'org-1' } as any,
      [{ id: 'managed', editorialTaskId: '4', editorialProfileRef: 'life-stories@v5' }] as any,
      'stale-occurrence'
    );
    expect(result).toEqual([]);
    expect(getSocialIntegration).not.toHaveBeenCalled();
    expect(deps._postsRepository.isDeleted).not.toHaveBeenCalled();
  });
});

describe('postSocial/postComment delete-after-claim guard', () => {
  it('postSocial returns [] without touching the provider when the post was deleted', async () => {
    const isDeleted = vi.fn().mockResolvedValue(true);
    const getSocialIntegration = vi.fn();
    const { activity } = build({
      _postsRepository: { isDeleted },
      _integrationManager: { getSocialIntegration },
    });

    const result = await activity.postSocial(
      { id: 'int-1', organizationId: 'org-1', providerIdentifier: 'x' } as any,
      [{ id: 'p1', content: 'hi' } as any]
    );

    expect(isDeleted).toHaveBeenCalledWith('p1');
    expect(result).toEqual([]);
    expect(getSocialIntegration).not.toHaveBeenCalled();
  });

  it('postComment returns [] without touching the provider when the post was deleted', async () => {
    const isDeleted = vi.fn().mockResolvedValue(true);
    const getSocialIntegration = vi.fn();
    const { activity } = build({
      _postsRepository: { isDeleted },
      _integrationManager: { getSocialIntegration },
    });

    const result = await activity.postComment(
      'root-release-id',
      undefined,
      { id: 'int-1', organizationId: 'org-1', providerIdentifier: 'x' } as any,
      [{ id: 'p2', content: 'comment' } as any]
    );

    expect(isDeleted).toHaveBeenCalledWith('p2');
    expect(result).toEqual([]);
    expect(getSocialIntegration).not.toHaveBeenCalled();
  });
});

describe('PostActivity.sendWebhooks event subscription filter', () => {
  const webhook = (over: Partial<Record<string, any>> = {}) => ({
    id: 'hook-1',
    url: 'https://example.com/hook',
    events: [],
    integrations: [],
    ...over,
  });

  const buildForSend = (webhooks: any[]) =>
    build({
      _webhookService: { getWebhooks: vi.fn().mockResolvedValue(webhooks) },
      _postService: {
        getPostByForWebhookId: vi.fn().mockResolvedValue({
          id: 'p1',
          content: 'hi',
          releaseURL: 'https://x.com/post/1',
          state: 'PUBLISHED',
          publishDate: new Date('2026-06-09T00:00:00.000Z'),
          integration: { providerIdentifier: 'x', name: 'My X' },
        }),
      },
    });

  it('delivers to legacy (empty events) and post.published-subscribed webhooks, skips the rest', async () => {
    const { activity } = buildForSend([
      webhook({ id: 'legacy', url: 'https://example.com/legacy', events: [] }),
      webhook({ id: 'sub', url: 'https://example.com/sub', events: ['post.published'] }),
      webhook({ id: 'other', url: 'https://example.com/other', events: ['comment.new'] }),
    ]);

    await activity.sendWebhooks('p1', 'org-1', 'int-1');

    const urls = safeFetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toEqual([
      'https://example.com/legacy',
      'https://example.com/sub',
    ]);
    const body = JSON.parse(safeFetchMock.mock.calls[0][1].body);
    expect(body.event).toBe('post.published');
    expect(body.data.postId).toBe('p1');
  });

  it('keeps integration scoping for post.published', async () => {
    const { activity } = buildForSend([
      webhook({
        id: 'match',
        url: 'https://example.com/match',
        events: ['post.published'],
        integrations: [{ id: 'int-1' }],
      }),
      webhook({
        id: 'mismatch',
        url: 'https://example.com/mismatch',
        events: ['post.published'],
        integrations: [{ id: 'int-2' }],
      }),
    ]);

    await activity.sendWebhooks('p1', 'org-1', 'int-1');

    expect(safeFetchMock.mock.calls.map((c) => c[0])).toEqual([
      'https://example.com/match',
    ]);
  });
});

describe('PostActivity.notifyPostFailed post.failed dispatch', () => {
  it('notifies and dispatches a post.failed webhook event', async () => {
    const notifyPostPublishFailure = vi.fn().mockResolvedValue(undefined);
    const dispatchEvent = vi.fn().mockResolvedValue(undefined);
    const { activity } = build({
      _notificationService: { notifyPostPublishFailure },
      _webhookService: { dispatchEvent },
    });

    await activity.notifyPostFailed('org-1', 'My X', 'p1', undefined, 'boom');

    expect(notifyPostPublishFailure).toHaveBeenCalledWith(
      'org-1',
      'My X',
      'p1',
      undefined,
      'boom'
    );
    expect(dispatchEvent).toHaveBeenCalledWith('org-1', 'post.failed', {
      postId: 'p1',
      integrationName: 'My X',
      error: 'boom',
    });
  });

  it('still resolves when the webhook dispatch throws', async () => {
    const { activity } = build({
      _notificationService: {
        notifyPostPublishFailure: vi.fn().mockResolvedValue(undefined),
      },
      _webhookService: {
        dispatchEvent: vi.fn().mockRejectedValue(new Error('db down')),
      },
    });

    await expect(
      activity.notifyPostFailed('org-1', 'My X', 'p1', 'comment', 'boom')
    ).resolves.toBeUndefined();
  });
});

describe('XDto poll validation (2.2)', () => {
  const makeX = (poll: any) =>
    plainToInstance(XDto, { who_can_reply_post: 'everyone', poll });

  it('rejects a 1-option poll', async () => {
    const errors = await validate(makeX({ options: ['only-one'], duration: 24 }));
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a disallowed duration', async () => {
    const errors = await validate(makeX({ options: ['a', 'b'], duration: 999 }));
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts a valid 2-4 option poll with an allowed duration', async () => {
    const errors = await validate(makeX({ options: ['a', 'b', 'c'], duration: 168 }));
    expect(errors).toHaveLength(0);
  });
});

describe('PostActivity MAX StoryGo immutable photo package', () => {
  it('binds actual org-owned bytes, 2+ parts and UUIDv5 to the single occurrence', async () => {
    const occurrenceId = 'max_' + 'a'.repeat(64);
    const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNUNPdlYGBgYmBgYGBgAAAHugCprKZFeAAAAABJRU5ErkJggg==','base64');
    const sha256 = createHash('sha256').update(imageBytes).digest('hex');
    const settings = {
      __type: 'max',
      mode: 'story',
      continuationText: 'Вторая часть\n────────────────────────\nТретья часть',
      storyImageId: 'a8db6639-7ba0-42b7-8587-dd39d630c91b',
      storyImageSha256: sha256,
    };
    const post = {
      id: 'a'.repeat(32), content: 'Заголовок\n\nПервая часть',
      organizationId: 'org-1', campaignId: null,
      settings: JSON.stringify(settings), image: '[]',
    } as any;
    const integration = {
      id: 'integration-1', organizationId: 'org-1',
      providerIdentifier: 'max', internalId: 'max:-123',
      providerVersion: 'v1', providerConfigId: null,
      name: 'Test MAX', token: 'BOT-SECRET',
    } as any;
    const sendPost = vi.fn().mockResolvedValue([
      { id: post.id, postId: 'mid.from-storygo', status: 'completed', releaseURL: '' },
    ]);
    const beginMaxDelivery = vi.fn().mockResolvedValue({
      attempt: 1, occurrenceId,
    });
    const confirmMaxDelivery = vi.fn().mockResolvedValue(undefined);
    const updateTags = vi.fn();
    const { activity } = build({
      _postService: {
        updateTags, updateMedia: vi.fn().mockResolvedValue([]),
        readStoryGoImage: vi.fn().mockResolvedValue({
          bytes: imageBytes, sha256, mimeType: 'image/png',
        }),
        beginMaxDelivery, confirmMaxDelivery,
      },
      _integrationManager: {
        getSocialIntegration: vi.fn().mockResolvedValue({
          editor: 'normal', post: sendPost,
        }),
        requireClientInformation: vi.fn().mockResolvedValue(undefined),
      },
      _integrationService: {
        getIntegrationById: vi.fn().mockResolvedValue(integration),
      },
      _orgProviderConfigService: {
        getVpnSelectionForIntegration: vi.fn().mockResolvedValue(null),
      },
    });
    const response = await activity.postSocial(integration, [post], occurrenceId, 1);
    expect(response[0].postId).toBe('mid.from-storygo');
    expect(updateTags).not.toHaveBeenCalled();
    const payload = sendPost.mock.calls[0][2][0];
    expect(payload.message).toBe(post.content);
    expect(payload.media).toEqual([]);
    expect(payload.settings.storyImageId).toBe(settings.storyImageId);
    expect(payload.settings.continuationText).toBe(settings.continuationText);
    expect(payload.settings.__gateway).toMatchObject({
      externalPostId: post.id, revision: occurrenceId,
      operationId: uuidv5('postmill:max:occurrence:' + occurrenceId, uuidv5.URL),
      image: { base64: imageBytes.toString('base64'), sha256, mimeType: 'image/png' },
    });
    expect(beginMaxDelivery.mock.calls[0][2]).toMatchObject({
      storyPhotoSha256: sha256,
      storygoOperationId: payload.settings.__gateway.operationId,
    });
    expect(confirmMaxDelivery).toHaveBeenCalledTimes(1);
    // Neither bot token nor base64 bytes are in the confirmed receipt.
    expect(JSON.stringify(confirmMaxDelivery.mock.calls)).not.toContain('BOT-SECRET');
    expect(JSON.stringify(confirmMaxDelivery.mock.calls)).not.toContain(imageBytes.toString('base64'));
  });

  it('blocks a replaced StoryGo image before occurrence claim or provider send', async () => {
    const post = {id:'b'.repeat(32),content:'Title\n\nOpening',organizationId:'org-1',campaignId:null,
      settings:JSON.stringify({__type:'max',mode:'story',continuationText:'Second\n────────────────────────\nThird',
        storyImageId:'a8db6639-7ba0-42b7-8587-dd39d630c91b',storyImageSha256:'f'.repeat(64)}),image:'[]'} as any;
    const integration={id:'integration-1',organizationId:'org-1',providerIdentifier:'max',internalId:'max:-123',
      providerVersion:'v1',providerConfigId:null,name:'Test MAX',token:'synthetic'} as any;
    const sendPost=vi.fn(); const beginMaxDelivery=vi.fn();
    const {activity}=build({_postService:{readStoryGoImage:vi.fn().mockResolvedValue({bytes:Buffer.from('changed'),sha256:'a'.repeat(64),mimeType:'image/png'}),beginMaxDelivery},
      _integrationManager:{getSocialIntegration:vi.fn().mockResolvedValue({editor:'normal',post:sendPost}),requireClientInformation:vi.fn().mockResolvedValue(undefined)},
      _integrationService:{getIntegrationById:vi.fn().mockResolvedValue(integration)},
      _orgProviderConfigService:{getVpnSelectionForIntegration:vi.fn().mockResolvedValue(null)}});
    await expect(activity.postSocial(integration,[post],'max_'+'a'.repeat(64),1)).rejects.toThrow();
    expect(beginMaxDelivery).not.toHaveBeenCalled(); expect(sendPost).not.toHaveBeenCalled();
  });
});

describe('PostActivity MAX normal media immutable snapshot', () => {
  it('reads owned media before occurrence claim and passes bytes ephemerally to the adapter', async () => {
    const bytes = Buffer.from('synthetic image bytes');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const post = {
      id: 'post-media', content: 'MAX image with caption',
      organizationId: 'org-1', campaignId: null,
      settings: JSON.stringify({ __type: 'max', mode: 'normal', maxMediaSha256: sha256 }),
      image: JSON.stringify([{ id: 'file-owned', path: 'photo.png' }]),
    } as any;
    const integration = {
      id: 'integration-1', organizationId: 'org-1',
      providerIdentifier: 'max', internalId: 'max:-123',
      providerVersion: 'v1', providerConfigId: null,
      name: 'Test MAX', token: 'BOT-SECRET',
    } as any;
    const sendPost = vi.fn().mockResolvedValue([
      { id: post.id, postId: 'mid.normal', status: 'completed', releaseURL: '' },
    ]);
    const beginMaxDelivery = vi.fn().mockResolvedValue({
      attempt: 1, occurrenceId: 'max_' + 'c'.repeat(64),
    });
    const confirmMaxDelivery = vi.fn().mockResolvedValue(undefined);
    const updateMedia = vi.fn();
    const readMaxNormalMedia = vi.fn().mockResolvedValue({
      bytes, sha256, mimeType: 'image/png', mediaType: 'image',
    });
    const { activity } = build({
      _postService: {
        updateTags: vi.fn().mockResolvedValue([post]),
        updateMedia, readMaxNormalMedia, beginMaxDelivery, confirmMaxDelivery,
      },
      _integrationService: { getIntegrationById: vi.fn().mockResolvedValue(integration) },
      _integrationManager: {
        getSocialIntegration: vi.fn().mockResolvedValue({
          editor: 'normal', post: sendPost,
        }),
        requireClientInformation: vi.fn().mockResolvedValue(undefined),
      },
      _orgProviderConfigService: {
        getVpnSelectionForIntegration: vi.fn().mockResolvedValue(null),
      },
    });
    const result = await activity.postSocial(integration, [post], 'max_' + 'c'.repeat(64), 1);
    expect(result[0].postId).toBe('mid.normal');
    expect(readMaxNormalMedia).toHaveBeenCalledWith('org-1', 'file-owned');
    expect(updateMedia).not.toHaveBeenCalled();
    expect(sendPost.mock.calls[0][2][0].settings.__maxMedia).toMatchObject({
      base64: bytes.toString('base64'), sha256, mimeType: 'image/png', mediaType: 'image',
    });
    expect(beginMaxDelivery.mock.calls[0][2]).toMatchObject({
      maxMediaSha256: sha256, maxMediaType: 'image',
    });
    expect(JSON.stringify(beginMaxDelivery.mock.calls)).not.toContain(bytes.toString('base64'));
    expect(JSON.stringify(confirmMaxDelivery.mock.calls)).not.toContain(bytes.toString('base64'));
  });
  it('refuses changed files before claiming a MAX occurrence', async () => {
    const bytes = Buffer.from('new bytes');
    const post = {
      id: 'post-media', content: 'Caption', campaignId: null,
      image: JSON.stringify([{ id: 'file-owned', path: 'photo.png' }]),
      settings: JSON.stringify({ mode: 'normal', maxMediaSha256: 'f'.repeat(64) }),
    } as any;
    const integration = {
      id: 'integration-1', organizationId: 'org-1',
      providerIdentifier: 'max', internalId: 'max:-123',
      providerVersion: 'v1', providerConfigId: null,
      name: 'MAX', token: 'BOT-SECRET',
    } as any;
    const beginMaxDelivery = vi.fn();
    const { activity } = build({
      _postService: {
        updateTags: vi.fn().mockResolvedValue([post]),
        readMaxNormalMedia: vi.fn().mockResolvedValue({
          bytes, mimeType: 'image/png', mediaType: 'image',
          sha256: createHash('sha256').update(bytes).digest('hex'),
        }),
        beginMaxDelivery,
      },
      _integrationService: { getIntegrationById: vi.fn().mockResolvedValue(integration) },
      _integrationManager: {
        getSocialIntegration: vi.fn().mockResolvedValue({ editor: 'normal' }),
        requireClientInformation: vi.fn().mockResolvedValue(undefined),
      },
      _orgProviderConfigService: {
        getVpnSelectionForIntegration: vi.fn().mockResolvedValue(null),
      },
    });
    await expect(activity.postSocial(integration, [post], 'max_' + 'c'.repeat(64), 1))
      .rejects.toThrow('attachment has changed');
    expect(beginMaxDelivery).not.toHaveBeenCalled();
  });
});

describe('MAX StoryGo crash-safe receipt recovery', () => {
  const candidate = {
    id: 'max_' + 'a'.repeat(64),
    postId: 'post-1',
    organizationId: 'org-1',
    attempt: 1,
    channelId: 'max:-73052031470103',
    operationId: 'e299b442-02a8-5acf-ab16-6ab92926d548',
    providerVersion: 'v1',
  };

  it('confirms a proven MID by GET without ever publishing again', async () => {
    const lookup = vi.fn().mockResolvedValue('mid.recovered');
    const confirm = vi.fn().mockResolvedValue(undefined);
    const { activity } = build({
      _postService: {
        unresolvedStoryGoOccurrences: vi.fn().mockResolvedValue([candidate]),
        confirmMaxDelivery: confirm,
        resetStalePublishingToQueue: vi.fn().mockResolvedValue(0),
        pendingMaxOccurrences: vi.fn().mockResolvedValue([]),
        searchForMissingThreeHoursPosts: vi.fn().mockResolvedValue([]),
      },
      _integrationManager: {
        getSocialIntegration: vi.fn().mockResolvedValue({
          reconcileStoryGoOperation: lookup,
        }),
      },
    });
    await activity.searchForMissingThreeHoursPosts();
    expect(lookup).toHaveBeenCalledWith(candidate.channelId, candidate.operationId);
    expect(confirm).toHaveBeenCalledWith(
      candidate.postId, candidate.organizationId, 1,
      { id: 'post-1', postId: 'mid.recovered', releaseURL: '', status: 'completed' },
      candidate.id,
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('keeps unknown or unavailable StoryGo receipt in REVIEW', async () => {
    const confirm = vi.fn();
    const { activity } = build({
      _postService: {
        unresolvedStoryGoOccurrences: vi.fn().mockResolvedValue([candidate]),
        confirmMaxDelivery: confirm,
        resetStalePublishingToQueue: vi.fn().mockResolvedValue(0),
        pendingMaxOccurrences: vi.fn().mockResolvedValue([]),
        searchForMissingThreeHoursPosts: vi.fn().mockResolvedValue([]),
      },
      _integrationManager: {
        getSocialIntegration: vi.fn().mockResolvedValue({
          reconcileStoryGoOperation: vi.fn().mockRejectedValue(new Error('synthetic timeout')),
        }),
      },
    });
    await expect(activity.searchForMissingThreeHoursPosts()).resolves.toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('028B.4B native classification boundary',()=>{
 it.each(['live','blocked'] as const)('never falls through on disabled or unresolved %s',async route=>{
  const classifyEditorialLiveRelease=vi.fn().mockResolvedValue(route);
  const readStoryGoImage=vi.fn(),beginMaxDelivery=vi.fn(),post=vi.fn();
  const {activity}=build({_postService:{classifyEditorialLiveRelease,readStoryGoImage,beginMaxDelivery},
    _integrationManager:{getSocialIntegration:vi.fn().mockResolvedValue({post})}});
  const integration={id:'mock-review-image-automatic',organizationId:'org-modes',
    providerIdentifier:'max',internalId:'max:-73052031470103'} as any;
  await expect(activity.postSocial(integration,[{id:'b'.repeat(32),image:'[]',settings:'{}'} as any],
    'max_'+'a'.repeat(64),1)).rejects.toThrow('operator review');
  expect(classifyEditorialLiveRelease).toHaveBeenCalledExactlyOnceWith('org-modes','b'.repeat(32));
  expect(readStoryGoImage).not.toHaveBeenCalled();expect(beginMaxDelivery).not.toHaveBeenCalled();
  expect(post).not.toHaveBeenCalled();
 });
});
