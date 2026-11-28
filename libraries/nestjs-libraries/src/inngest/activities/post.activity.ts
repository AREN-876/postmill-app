import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MaxProvider } from '@postmill-ai/provider-max';
import { qualifyPrivateReleaseHandoff } from '@postmill-ai/nestjs-libraries/database/prisma/posts/editorial-private-release-photo';
import { EditorialPrivateImageStore } from '@postmill-ai/nestjs-libraries/database/prisma/posts/editorial-private-image';
import { editorialWireConfig, type EditorialWireConfig } from '@postmill-ai/nestjs-libraries/database/prisma/posts/editorial-signed-transport';
import { v5 as uuidv5 } from 'uuid';
import { maxStoryParts } from '@postmill-ai/provider-kernel/domains/max-story';
import { Injectable, Logger } from '@nestjs/common';
import { PostsService } from '@postmill-ai/nestjs-libraries/database/prisma/posts/posts.service';
import { NotificationService } from '@postmill-ai/nestjs-libraries/database/prisma/notifications/notification.service';
import { Integration, Post, State } from '@prisma/client';
import { makeId } from '@postmill-ai/nestjs-libraries/services/make.is';
import { stripHtmlValidation } from '@postmill-ai/helpers/utils/strip.html.validation';
import { IntegrationManager } from '@postmill-ai/nestjs-libraries/integrations/integration.manager';
import { AuthTokenDetails } from '@postmill-ai/nestjs-libraries/integrations/social/social.integrations.interface';
import { RefreshIntegrationService } from '@postmill-ai/nestjs-libraries/integrations/refresh.integration.service';
import { timer } from '@postmill-ai/helpers/utils/timer';
import { IntegrationService } from '@postmill-ai/nestjs-libraries/database/prisma/integrations/integration.service';
import { WebhooksService } from '@postmill-ai/nestjs-libraries/database/prisma/webhooks/webhooks.service';
import { safeFetch } from '@postmill-ai/nestjs-libraries/dtos/webhooks/safe.fetch';
import { PROVIDER_CAPABILITIES } from '@postmill-ai/nestjs-libraries/integrations/social/provider-capabilities';
import { SubscriptionService } from '@postmill-ai/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import {
  inngest,
  isInngestEnabled,
} from '@postmill-ai/nestjs-libraries/inngest/inngest.client';
import { BadBodyError } from '@postmill-ai/nestjs-libraries/inngest/errors/bad-body.error';
import { OrgProviderConfigService } from '@postmill-ai/nestjs-libraries/database/prisma/provider-configs/org-provider-config.service';
import { OrgVpnConfigService } from '@postmill-ai/nestjs-libraries/vpn/org-vpn-config.service';
import { VpnDispatcherService } from '@postmill-ai/nestjs-libraries/vpn/vpn-dispatcher.service';
import { runWithVpnDispatcher } from '@postmill-ai/nestjs-libraries/vpn/vpn.context';
import { CampaignsRepository } from '@postmill-ai/nestjs-libraries/database/prisma/campaigns/campaigns.repository';
import { PostsRepository } from '@postmill-ai/nestjs-libraries/database/prisma/posts/posts.repository';
import { v4 as uuidv4 } from 'uuid';
import { CircuitBreakerService } from '@postmill-ai/nestjs-libraries/ai/governance/circuit-breaker.service';
import { webhookSignature, webhookTimeoutMs } from '@postmill-ai/nestjs-libraries/dtos/webhooks/safe.fetch';
import type { Dispatcher } from 'undici';
import { billingEnabled } from '@postmill-ai/helpers/billing/payments.env';

// Drops fields the workflow and downstream activities never read — biggest wins are `error` (grows per retry) and `childrenPost` (Prisma side-loads it on every recursive row).
// 2.5: also strips the decrypted OAuth secrets (`token`/`refreshToken`/
// `customInstanceDetails`) from the side-loaded `integration` so plaintext
// secrets never land in Inngest run state. The publish/refresh steps re-read the
// decrypted integration by id from the DB (see `_withDecryptedIntegration`).
function slimPost(post: any) {
  if (!post) return post;
  const {
    error,
    childrenPost,
    tags,
    description,
    title,
    parentPostId,
    deletedAt,
    createdAt,
    updatedAt,
    comments,
    errors,
    integration,
    ...rest
  } = post;
  if (!integration) return rest;
  const {
    token,
    refreshToken,
    customInstanceDetails,
    ...safeIntegration
  } = integration;
  return { ...rest, integration: safeIntegration };
}

@Injectable()
export class PostActivity {
  private readonly logger = new Logger(PostActivity.name);

  // D2: per-(provider, org) circuit breaker around the social post() path. The
  // breaker is process-local and conservative — `SocialAbstract.fetch` already
  // retries transient 429/5xx internally, so a thrown post() error is post-retry
  // ("hard"). Opens only after several consecutive hard failures, then fast-fails
  // during cooldown and half-opens with a single probe.
  private readonly _socialBreaker = new CircuitBreakerService({
    failureThreshold: 5,
    cooldownMs: 60_000,
  });

  constructor(
    private _postService: PostsService,
    private _notificationService: NotificationService,
    private _integrationManager: IntegrationManager,
    private _integrationService: IntegrationService,
    private _refreshIntegrationService: RefreshIntegrationService,
    private _webhookService: WebhooksService,
    private _subscriptionService: SubscriptionService,
    private _orgProviderConfigService: OrgProviderConfigService,
    private _orgVpnConfigService: OrgVpnConfigService,
    private _vpnDispatcherService: VpnDispatcherService,
    // layering: sanctioned leaf-read — UTM append only needs the campaign's
    // utmEnabled flag; CampaignsService depends on PostsService, so routing up
    // through the service layer would create a NestJS dependency-injection cycle.
    private _campaignsRepository: CampaignsRepository,
    // layering: sanctioned leaf-read — atomic publish claim delegates straight
    // to the repo (mirrors the injected _campaignsRepository above).
    private _postsRepository: PostsRepository
  ) {}

  // 0.7: atomic publish-state claim. Delegates to the repository's
  // `updateMany({ state: 'QUEUE' → 'PUBLISHING' })` which returns the row count
  // (1 = this run won the claim, 0 = a concurrent/stale run already claimed it).
  async claimForPublish(id: string, orgId: string) {
    return this._postsRepository.claimForPublish(id, orgId);
  }

  // Resolve the per-channel VPN proxy dispatcher (or undefined) for a publish.
  // Non-fatal: any resolution failure falls back to direct egress so a VPN
  // misconfig never blocks a post.
  private async _resolveVpnDispatcher(
    integration: Integration
  ): Promise<Dispatcher | undefined> {
    try {
      const selection = await this._orgProviderConfigService.getVpnSelectionForIntegration(
        integration.organizationId,
        integration.providerConfigId,
        integration.providerIdentifier
      );
      if (!selection) return undefined;

      const resolved = await this._orgVpnConfigService.resolveProxyForChannel(
        integration.organizationId,
        selection.identifier,
        selection.regionId,
        selection.vpnVersion
      );
      if (!resolved) return undefined;

      return this._vpnDispatcherService.get(
        integration.organizationId,
        selection.identifier,
        resolved
      );
    } catch (err) {
      this.logger.warn(
        `VPN dispatcher resolution failed for integration ${integration.id}: ${(err as Error)?.message}`
      );
      return undefined;
    }
  }

  async getIntegrationById(orgId: string, id: string) {
    return this._integrationService.getIntegrationById(orgId, id);
  }

  // 2.5: the integration carried in step state has been slimmed of its decrypted
  // token/refreshToken (see slimPost). Any step that actually posts or refreshes
  // re-reads the decrypted integration by id from the DB — which
  // refreshTokenWithCause has already persisted after a rotation, so a refresh
  // followed by a re-post picks up the fresh token.
  private async _withDecryptedIntegration(
    integration: Integration
  ): Promise<Integration> {
    if (integration.providerIdentifier !== 'max' && (integration as any)?.token) {
      return integration;
    }
    const full = await this._integrationService.getIntegrationById(
      integration.organizationId,
      integration.id
    );
    return ((full as unknown) as Integration) ?? integration;
  }

  planMaxOccurrence(id: string, org: string, occurrence: string) { return this._postService.planMaxOccurrence(id, org, occurrence); }
  failMaxOccurrence(id: string, org: string, occurrence: string) { return this._postService.failMaxOccurrence(id, org, occurrence); }

  /**
   * A confirmed StoryGo MID may survive a Postmill crash between Gateway POST
   * and PostgreSQL confirmation. Reconcile older STARTED/REVIEW attempts by
   * read-only GET; this path is incapable of sending another MAX message.
   */
  private async reconcileStoryGoReceipts() {
    let candidates: Awaited<ReturnType<PostsService['unresolvedStoryGoOccurrences']>>;
    try {
      candidates = await this._postService.unresolvedStoryGoOccurrences();
    } catch {
      this.logger.warn('StoryGo receipt reconciliation query failed');
      return;
    }
    for (const item of candidates) {
      try {
        const adapter = await this._integrationManager.getSocialIntegration(
          'max', item.organizationId, item.providerVersion ?? undefined,
        );
        // IntegrationManager.getSocialIntegration() already returns the raw
        // provider (unwrapped from SocialProviderKernelAdapter).
        const publisher = adapter as any;
        if (typeof publisher?.reconcileStoryGoOperation !== 'function') continue;
        const mid = await publisher.reconcileStoryGoOperation(
          item.channelId, item.operationId,
        );
        if (!mid) continue;
        await this._postService.confirmMaxDelivery(
          item.postId, item.organizationId, item.attempt,
          { id: item.postId, postId: mid, releaseURL: '', status: 'completed' },
          item.id,
        );
      } catch {
        // Never leak remote response bodies or credentials to logs. Failed GET
        // keeps the occurrence in REVIEW for the next sweep/manual inspection.
        this.logger.warn('StoryGo receipt reconciliation was inconclusive');
      }
    }
  }

  async searchForMissingThreeHoursPosts() {
    await this.reconcileStoryGoReceipts();
    // Requeue safe orphaned claims, but quarantine uncertain MAX deliveries.
    // The durable MAX journal is never cleared by the missing-post sweep.
    await this._postService.resetStalePublishingToQueue();
    try {
    const maxPending = await this._postService.pendingMaxOccurrences();
    for (const occurrence of maxPending) {
      if (isInngestEnabled()) await inngest.send({ name: 'post/publish',
        id: `max_recovery_${occurrence.id}_${uuidv4()}`,
        data: { postId: occurrence.postId, organizationId: occurrence.organizationId,
          taskQueue: 'max', maxConcurrentJob: 1, postNow: true, repeat: true, maxOccurrenceId: occurrence.id, maxDeliveryAttempt: occurrence.attempt + 1 } });
    }
    } catch {
      // MAX-specific recovery must not prevent the ordinary provider sweep.
      this.logger.warn('MAX occurrence recovery failed; ordinary recovery continues');
    }
    const list = await this._postService.searchForMissingThreeHoursPosts();
    for (const post of list) {
      // 5.4: thread the row's pinned version so recovery resolves the EXACT
      // adapter (the providerVersion selected in searchForMissingThreeHoursPosts
      // was otherwise dead). Safe post-1.3: a retired version resolves to
      // undefined (→ maxConcurrentJob defaults to 1, recovery still enqueues; the
      // publish step surfaces the retired adapter) rather than aborting the sweep.
      const provider = this._integrationManager.getSocialIntegrationUnchecked(
        post.integration.providerIdentifier,
        post.integration.providerVersion ?? undefined
      );
      const taskQueue = post.integration.providerIdentifier
        .split('-')[0]
        .toLowerCase();
      const maxConcurrentJob = provider?.maxConcurrentJob ?? 1;

      if (isInngestEnabled()) {
        await inngest.send({
          name: 'post/cancel',
          data: { postId: post.id },
        });
        await inngest.send({
          name: 'post/publish',
          data: {
            postId: post.id,
            organizationId: post.organizationId,
            taskQueue,
            maxConcurrentJob,
            postNow: true,
          },
          // 0.8: unique-per-send id so successive hourly recovery attempts (and a
          // reschedule's replacement event) are not deduped against a constant
          // `post_${id}` for ~24h. Double-sends are now caught by the 0.7 atomic
          // claim, not by Inngest event dedup.
          id: `post_${post.id}_recovery_${uuidv4()}`,
        });
      } else {
        this.logger.debug(
          `Inngest disabled; skipping recovery re-enqueue for post ${post.id}`
        );
      }
    }
  }

  async updatePost(id: string, postId: string, releaseURL: string, orgId: string) {
    await this._postService.updatePost(id, postId, releaseURL, orgId);
  }

  async getPost(orgId: string, postId: string) {
    if (billingEnabled()) {
      const subscription = await this._subscriptionService.getSubscription(
        orgId
      );
      if (!subscription) {
        return false;
      }
    }
    const post = await this._postService.getPostById(postId, orgId);
    // 4.4b: getPostById can return null for a missing/foreign id — guard before
    // reading .deletedAt so a deleted/absent post returns false instead of
    // throwing inside step.run.
    if (!post || post.deletedAt) {
      return false;
    }

    return slimPost(post);
  }

  async getPostsList(orgId: string, postId: string) {
    if (billingEnabled()) {
      const subscription = await this._subscriptionService.getSubscription(
        orgId
      );
      if (!subscription) {
        return [];
      }
    }

    const getPosts = await this._postService.getPostsRecursively(
      postId,
      true,
      orgId
    );
    if (!getPosts || getPosts.length === 0 || getPosts[0].parentPostId) {
      return [];
    }

    return getPosts.map(slimPost);
  }

  async isCommentable(integration: Integration) {
    const getIntegration = await this._integrationManager.getSocialIntegration(
      integration.providerIdentifier,
      integration.organizationId,
      integration.providerVersion
    );

    return !!getIntegration.comment;
  }

  async supportsFirstComment(integration: Integration) {
    const capabilities =
      PROVIDER_CAPABILITIES[
        integration.providerIdentifier as keyof typeof PROVIDER_CAPABILITIES
      ];
    if (!capabilities?.firstComment) {
      return false;
    }

    const getIntegration = await this._integrationManager.getSocialIntegration(
      integration.providerIdentifier,
      integration.organizationId,
      integration.providerVersion
    );

    return !!getIntegration.comment;
  }

  // Delete-after-claim race guard: the atomic claim flips state to PUBLISHING
  // before the publish work, and a group delete landing after it is never
  // re-checked. Re-read the post's deletedAt (cheap primary-key lookup) and
  // bail quietly — the caller treats an empty result as "nothing published,
  // end the run", so no spurious ERROR state or failure notification lands on
  // a post the user deleted. Every post in a group is soft-deleted together,
  // so checking the first payload post covers threads too.
  private async _bailIfDeleted(posts: Post[]): Promise<boolean> {
    const id = posts?.[0]?.id;
    if (!id) {
      return false;
    }
    const deleted = await this._postsRepository.isDeleted(id);
    if (deleted) {
      this.logger.warn(`Skipping publish for post ${id} — post was deleted`);
    }
    return deleted;
  }

  async postComment(
    postId: string,
    lastPostId: string | undefined,
    integration: Integration,
    posts: Post[]
  ) {
    if (await this._bailIfDeleted(posts)) {
      return [];
    }

    // 2.5: re-read the decrypted token (slimmed out of step state).
    integration = await this._withDecryptedIntegration(integration);

    const getIntegration = await this._integrationManager.getSocialIntegration(
      integration.providerIdentifier,
      integration.organizationId,
      integration.providerVersion
    );

    const newPosts = await this._postService.updateTags(
      integration.organizationId,
      posts
    );

    const clientInformation = await this._integrationManager.requireClientInformation(
      integration.providerIdentifier,
      integration.organizationId,
      integration.providerConfigId
    ).catch(() => undefined);

    const commentPayload = await Promise.all(
      (newPosts || []).map(async (p) => {
        const settings = JSON.parse(p.settings || '{}');
        return {
          id: p.id,
          message: stripHtmlValidation(
            getIntegration.editor,
            p.content,
            true,
            false,
            !/<\/?[a-z][\s\S]*>/i.test(p.content),
            getIntegration.mentionFormat
          ),
          settings,
          media: await this._postService.updateMedia(
            p.id,
            JSON.parse(p.image || '[]'),
            getIntegration?.convertToJPEG || false,
            integration.organizationId
          ),
          // 2.2: lift the composer's poll (stored in settings) to the top level.
          ...(settings.poll ? { poll: settings.poll } : {}),
        };
      })
    );

    // 2.2: never publish a plain comment when a poll was requested on a provider
    // that can't do polls.
    this._assertPollSupported(integration.providerIdentifier, commentPayload);

    return getIntegration.comment(
      integration.internalId,
      postId,
      lastPostId,
      integration.token,
      commentPayload,
      integration,
      clientInformation
    );
  }

  async postFirstComment(
    postId: string,
    integration: Integration,
    firstComment: string,
    originalSettings?: Record<string, unknown>
  ) {
    // 2.5: re-read the decrypted token (slimmed out of step state).
    integration = await this._withDecryptedIntegration(integration);

    const getIntegration = await this._integrationManager.getSocialIntegration(
      integration.providerIdentifier,
      integration.organizationId,
      integration.providerVersion
    );

    const clientInformation = await this._integrationManager.requireClientInformation(
      integration.providerIdentifier,
      integration.organizationId,
      integration.providerConfigId
    ).catch(() => undefined);

    return getIntegration.comment(
      integration.internalId,
      postId,
      undefined,
      integration.token,
      [
        {
          id: makeId(10),
          message: stripHtmlValidation(
            getIntegration.editor,
            firstComment,
            true,
            false,
            !/<\/?[a-z][\s\S]*>/i.test(firstComment),
            getIntegration.mentionFormat
          ),
          // Providers whose comments need the original post's targeting (e.g.
          // Discord's settings.channel for the thread's parent channel) must
          // see it — an empty settings object 404s the thread creation.
          settings: originalSettings || {},
          media: [],
        },
      ],
      integration,
      clientInformation
    );
  }

  private async _maybeAppendUtm(content: string, campaignId: string | null, organizationId: string, providerIdentifier: string): Promise<string> {
    if (!campaignId) return content;
    const campaign = await this._campaignsRepository.findById(campaignId, organizationId);
    if (!campaign?.utmEnabled) return content;

    const slug = encodeURIComponent(campaign.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''));
    const utm = `utm_campaign=${slug}&utm_source=${encodeURIComponent(providerIdentifier)}&utm_medium=social`;

    return content.replace(/(https?:\/\/[^\s<"']+)/g, (url) => {
      if (url.includes('utm_campaign')) return url;
      const sep = url.includes('?') ? '&' : '?';
      return `${url}${sep}${utm}`;
    });
  }

  // 2.2: capability guard. If any payload item carries a poll but the provider's
  // `poll` capability is false, throw a non-retriable BadBodyError so the post is
  // never silently published as a plain post.
  private _assertPollSupported(
    providerIdentifier: string,
    payload: { poll?: unknown }[]
  ) {
    if (!payload.some((p) => p.poll)) {
      return;
    }
    const capabilities =
      PROVIDER_CAPABILITIES[
        providerIdentifier as keyof typeof PROVIDER_CAPABILITIES
      ];
    if (!capabilities?.poll) {
      throw new BadBodyError(
        providerIdentifier,
        '{}',
        '',
        `Provider ${providerIdentifier} does not support polls`
      );
    }
  }

  private editorialLiveWorkerEnabled(integration: Integration): boolean {
    const env=process.env;
    return integration.organizationId==='org-modes' &&
      integration.id==='mock-review-image-automatic' &&
      integration.internalId==='max:-73052031470103' && integration.providerIdentifier==='max' &&
      env.EDITORIAL_TEST_SESSION_ENABLED==='true' && env.EDITORIAL_TEST_ORG_ID==='org-modes' &&
      env.EDITORIAL_TEST_MAX_TARGET==='max:-73052031470103' &&
      env.EDITORIAL_TEST_RELEASE_ENABLED==='true' &&
      env.EDITORIAL_TEST_LIVE_IMAGE_IMPORT_ENABLED==='true' &&
      env.EDITORIAL_TEST_LIVE_IMAGE_REVIEW_ENABLED==='true' &&
      env.EDITORIAL_TEST_LIVE_IMAGE_PREVIEW_ENABLED==='true' &&
      env.EDITORIAL_TEST_LIVE_IMAGE_RELEASE_WORKER_ENABLED==='1';
  }

  // A native live release never falls through to ordinary media.
  private async postEditorialLiveRelease(integration: Integration, posts: Post[],
    occurrence?: string, attempt?: number) {
    const denied=()=>new BadBodyError('max','{}','','Editorial live release requires operator review');
    try {
      if (!this.editorialLiveWorkerEnabled(integration) || posts.length!==1 ||
          !occurrence || !/^max_[0-9a-f]{64}$/.test(occurrence) || attempt!==1) throw denied();
      const p=posts[0];
      if (!/^[0-9a-f]{32}$/.test(p.id) || p.organizationId!==integration.organizationId ||
          p.integrationId!==integration.id || p.image!=='[]' || typeof p.settings!=='string') throw denied();
      const settings=JSON.parse(p.settings);
      if(settings?.mode!=='story' || settings.__gateway!==undefined || settings.__maxMedia!==undefined ||
          settings.poll || settings.firstComment) throw denied();
      const org=integration.organizationId;
      const partsSha256=createHash('sha256').update(JSON.stringify(maxStoryParts(p.content,settings.continuationText))).digest('hex');
      const expected={content:p.content,settings:p.settings,integrationId:integration.id,partsSha256};
      const identity={orgId:org,publicationPostId:p.id,occurrenceId:occurrence,attempt:1 as const};
      const wire:EditorialWireConfig={orgId:org,allowLiveImageRead:true,allowLiveImageReview:true,
        allowLiveImagePreview:true,
        requestKeyHex:readFileSync('/run/secrets/postmill_editorial_request_hmac_hex','utf8').trim(),
        responseKeyHex:readFileSync('/run/secrets/postmill_editorial_response_hmac_hex','utf8').trim()};
      editorialWireConfig(wire);
      const provider=await this._integrationManager.getSocialIntegration('max',org,integration.providerVersion);
      if(!(provider instanceof MaxProvider)) throw denied();
      const vpn=await this._resolveVpnDispatcher(integration);
      const read=async(operation?:string)=>{
        if(!this.editorialLiveWorkerEnabled(integration)) return null;
        return this._postService.readEditorialLiveReleasePhoto(org,p.id,occurrence,expected,operation);
      };
      let result: Awaited<ReturnType<MaxProvider['postEditorialLiveStory']>> = [];
      const status=await qualifyPrivateReleaseHandoff(identity,{
        read:()=>read(), open:()=>EditorialPrivateImageStore.open(), wire,
        claim:async(_id,operationId,photoSha256)=>{
          if(!this.editorialLiveWorkerEnabled(integration)) return null;
          return this._postService.beginMaxDelivery(p.id,org,{
            content:p.content,integrationName:integration.name,integrationId:integration.id,
            chatId:integration.internalId,providerConfigId:integration.providerConfigId ?? null,
            version:integration.providerVersion ?? 'v1',
            textSha256:createHash('sha256').update(p.content).digest('hex'),
            storygoOperationId:operationId,storyPartsSha256:partsSha256,storyPhotoSha256:photoSha256,
          },occurrence,1);
        },
        readStarted:(_id,operationId)=>read(operationId),
        hold:async()=>{await this._postService.failMaxOccurrence(p.id,org,occurrence);},
        send:async(payload,authority)=>{
          if(!this.editorialLiveWorkerEnabled(integration)) throw denied();
          const response=await runWithVpnDispatcher(vpn,()=>provider.postEditorialLiveStory(
            integration.internalId,{id:p.id,message:p.content,settings,media:[]},payload.image,{
              kind:'editorial-live-story',
              identity:{orgId:org,publicationPostId:p.id,occurrenceId:occurrence,attempt:1,
                operationId:payload.operationId,channelId:integration.internalId.slice(4),
                fingerprint:authority.fingerprint,storyPartsSha256:partsSha256,photoSha256:payload.image.sha256},
              beforePublication:authority.beforePublication,
            }));
          if(response.length!==1 || response[0].id!==p.id || !response[0].postId ||
              response[0].status!=='completed') throw denied();
          await this._postService.confirmMaxDelivery(p.id,org,1,response[0],occurrence);
          result=response;
        },
      });
      if(status.status==='not_claimed') return [];
      if(status.status!=='handoff_returned' || result.length!==1) throw denied();
      return result;
    } catch {
      // No raw exception or private path escapes; STARTED fences ambiguous commits.
      throw denied();
    }
  }

  async postSocial(integration: Integration, posts: Post[], maxOccurrenceId?: string, maxDeliveryAttempt?: number) {
    // 06A: refuse inactive managed rows at the provider boundary as well.
    // The row identity cannot be removed or added retroactively in PostgreSQL.
    if (posts.some((p) => p.editorialTaskId != null || p.editorialProfileRef != null)) {
      return [];
    }
    if (await this._bailIfDeleted(posts)) {
      return [];
    }

    if (billingEnabled()) {
      const subscription = await this._subscriptionService.getSubscription(
        integration.organizationId
      );

      if (!subscription) {
        throw new Error('No active subscription found for this organization.');
      }
    }

    // Native release classification is independent of cached job settings.
    const routes=await Promise.all(posts.map(p=>
      this._postService.classifyEditorialLiveRelease(integration.organizationId,p.id)));
    if(routes.some(route=>route!=='ordinary')) {
      if(routes.length===1 && routes[0]==='live')
        return this.postEditorialLiveRelease(integration,posts,maxOccurrenceId,maxDeliveryAttempt);
      throw new BadBodyError('max','{}','','Editorial release classification unavailable; operator review required');
    }

    // 2.5: re-read the decrypted token (slimmed out of step state).
    integration = await this._withDecryptedIntegration(integration);

    const getIntegration = await this._integrationManager.getSocialIntegration(
      integration.providerIdentifier,
      integration.organizationId,
      integration.providerVersion
    );

    // A story is an approved immutable package. No cross-post substitution
    // after the occurrence was claimed.
    const storyMode = integration.providerIdentifier === 'max' &&
      JSON.parse(posts[0]?.settings || '{}')?.mode === 'story';
    const normalMax = integration.providerIdentifier === 'max' && !storyMode;
    const newPosts = storyMode ? posts : await this._postService.updateTags(
      integration.organizationId,
      posts
    );

    const clientInformation = await this._integrationManager.requireClientInformation(
      integration.providerIdentifier,
      integration.organizationId,
      integration.providerConfigId
    ).catch(() => undefined);

    // If the channel has an enabled VPN selection, route every outbound request
    // this provider makes through that region's proxy via AsyncLocalStorage.
    const vpnDispatcher = await this._resolveVpnDispatcher(integration);

    const postPayload = await Promise.all(
      (newPosts || []).map(async (p) => {
        const contentWithUtm = storyMode ? p.content : await this._maybeAppendUtm(
          p.content,
          p.campaignId,
          integration.organizationId,
          integration.providerIdentifier
        );
        const settings = JSON.parse(p.settings || '{}');
        return {
          id: p.id,
          message: storyMode ? contentWithUtm : stripHtmlValidation(
            getIntegration.editor,
            contentWithUtm,
            true,
            false,
            !/<\/?[a-z][\s\S]*>/i.test(contentWithUtm),
            getIntegration.mentionFormat
          ),
          settings,
          media: normalMax || storyMode
            ? JSON.parse(p.image || '[]')
            : await this._postService.updateMedia(
                p.id,
                JSON.parse(p.image || '[]'),
                getIntegration?.convertToJPEG || false,
                integration.organizationId
              ),
          // 2.2: lift the composer's poll (stored in settings) up to the
          // top-level `poll` the adapter reads.
          ...(settings.poll ? { poll: settings.poll } : {}),
        };
      })
    );

    // Read photo bytes only from the current organization-owned File row and
    // verify the SHA frozen at scheduling. No untrusted URL/FS path is fetched.
    let storyPhoto: { base64: string; mimeType: string; sha256: string } | undefined;
    if (storyMode && postPayload[0].settings.storyImageId) {
      const img = await this._postService.readStoryGoImage(
        integration.organizationId, postPayload[0].settings.storyImageId,
      );
      if (img.sha256 !== postPayload[0].settings.storyImageSha256) {
        throw new BadBodyError('max', '{}', '',
          'Approved StoryGo photo has changed; do not publish');
      }
      storyPhoto = {
        base64: img.bytes.toString('base64'),
        mimeType: img.mimeType,
        sha256: img.sha256,
      };
    }

    // Normal MAX media must resolve to an org-owned stored File, never an
    // external URL or untrusted path from the request. Recheck the approved
    // digest immediately before claiming a non-repeatable MAX occurrence.
    let maxMedia: { base64: string; mimeType: string; mediaType: 'image' | 'video'; sha256: string } | undefined;
    if (normalMax && postPayload[0].media?.length === 1) {
      const fileId = (postPayload[0].media[0] as any).id;
      const asset = await this._postService.readMaxNormalMedia(integration.organizationId, fileId);
      if (asset.sha256 !== postPayload[0].settings.maxMediaSha256) {
        throw new BadBodyError('max', '{}', '', 'Approved MAX attachment has changed; do not publish');
      }
      maxMedia = {
        base64: asset.bytes.toString('base64'),
        mimeType: asset.mimeType,
        mediaType: asset.mediaType,
        sha256: asset.sha256,
      };
    }

    // 2.2: never publish a plain post when a poll was requested but this provider
    // can't do polls — fail hard (non-retriable) instead of silently dropping it.
    this._assertPollSupported(integration.providerIdentifier, postPayload);

    // D2: short-circuit when this provider×org breaker is OPEN.
    const breakerKey = `${integration.providerIdentifier}:${integration.organizationId}`;
    if (!this._socialBreaker.canAttempt(breakerKey)) {
      throw new Error(
        `Provider ${integration.providerIdentifier} temporarily unavailable (circuit open) — skipping to retry later`
      );
    }

    const maxAttempt = integration.providerIdentifier === 'max'
      ? await this._postService.beginMaxDelivery(posts[0].id, integration.organizationId, {
        content: postPayload[0].message, integrationName: integration.name,
        integrationId: integration.id, chatId: integration.internalId, providerConfigId: integration.providerConfigId ?? null, version: integration.providerVersion ?? 'v1',
        textSha256: createHash('sha256').update(postPayload[0].message).digest('hex'),
        ...(storyMode && maxOccurrenceId ? {
          storygoOperationId: uuidv5('postmill:max:occurrence:' + maxOccurrenceId, uuidv5.URL),
        } : {}),
        ...(storyMode ? {
          storyPartsSha256: createHash('sha256').update(JSON.stringify(
            maxStoryParts(postPayload[0].message, postPayload[0].settings.continuationText)
          )).digest('hex'),
          ...(storyPhoto ? { storyPhotoSha256: storyPhoto.sha256 } : {}),
        } : {}),
        ...(normalMax && maxMedia ? { maxMediaSha256: maxMedia.sha256, maxMediaType: maxMedia.mediaType } : {}),
      }, maxOccurrenceId, maxDeliveryAttempt) : undefined;
    if (maxAttempt?.alreadyConfirmed) return [];
    // A previous StoryGo revision is unresolved. Leave this occurrence READY;
    // the existing missing-post sweep will safely redispatch its stable key.
    if (maxAttempt?.deferred) return [];
    if (integration.providerIdentifier === 'max' && (!maxAttempt || maxAttempt.blocked || !Number.isInteger(maxAttempt.attempt))) throw new BadBodyError('max', '{}', '', 'MAX delivery unknown or already in progress: operator review required');
    const outbound = storyMode && maxAttempt?.occurrenceId
      ? postPayload.map((item) => ({
          ...item,
          settings: {
            ...item.settings,
            __gateway: {
              operationId: uuidv5(
                'postmill:max:occurrence:' + maxAttempt.occurrenceId,
                uuidv5.URL,
              ),
              externalPostId: posts[0].id,
              revision: maxAttempt.occurrenceId,
              ...(storyPhoto ? { image: storyPhoto } : {}),
            },
          },
        }))
      : normalMax && maxMedia
        ? postPayload.map((item) => ({
            ...item,
            settings: { ...item.settings, __maxMedia: maxMedia },
          }))
        : postPayload;
    let postNow;
    try {
      postNow = await runWithVpnDispatcher(vpnDispatcher, () =>
        getIntegration.post(
          integration.internalId,
          integration.token,
          outbound,
          integration,
          clientInformation
        )
      );
      if (maxAttempt) {
        if (!postNow?.[0]?.postId) throw new BadBodyError('max', '{}', '', 'MAX delivery unconfirmed; operator review required');
        await this._postService.confirmMaxDelivery(posts[0].id, integration.organizationId, maxAttempt.attempt, postNow[0], maxAttempt.occurrenceId);
      }
      this._socialBreaker.recordSuccess(breakerKey);
    } catch (err) {
      // Only count infra-class failures (timeouts, 5xx, network) toward the breaker.
      // A BadBodyError is a permanent per-post content/4xx rejection (NonRetriableError) —
      // it does NOT mean the provider is down, so a batch of legitimately-bad posts must
      // not open the breaker and delay this org's good posts. Leave the breaker untouched.
      if (!(err instanceof BadBodyError)) {
        this._socialBreaker.recordFailure(breakerKey);
      }
      throw err;
    }

    if (isInngestEnabled()) {
      await inngest.send({
        name: 'streak/start',
        data: { organizationId: integration.organizationId },
        id: `streak_${integration.organizationId}`,
      });
    } else {
      this.logger.debug(
        `Inngest disabled; skipping streak/start for org ${integration.organizationId}`
      );
    }

    return postNow;
  }

  async notifyChannelError(
    orgId: string,
    integrationName: string,
    providerIdentifier: string,
    reason: 'refresh' | 'disabled',
    postId?: string
  ) {
    await this._notificationService.notifyChannelError(
      orgId,
      integrationName,
      providerIdentifier,
      reason,
      postId
    );
  }

  async notifyPostPublished(
    orgId: string,
    integrationName: string,
    releaseURL: string,
    postId: string
  ) {
    await this._notificationService.notifyPostPublished(
      orgId,
      integrationName,
      releaseURL,
      postId
    );
  }

  async notifyPostFailed(
    orgId: string,
    integrationName: string,
    postId: string,
    subStep?: string,
    errMessage?: string
  ) {
    await this._notificationService.notifyPostPublishFailure(
      orgId,
      integrationName,
      postId,
      subStep,
      errMessage
    );

    // Same error-swallowed posture as the other dispatch sites — a webhook
    // failure must not mask the notification above or fail the publish step.
    try {
      await this._webhookService.dispatchEvent(orgId, 'post.failed', {
        postId,
        integrationName,
        ...(subStep ? { subStep } : {}),
        error: errMessage ?? null,
      });
    } catch (err) {
      this.logger.warn(
        `post.failed webhook dispatch failed: ${(err as Error)?.message}`
      );
    }
  }

  async notifyFirstCommentUnsupported(
    orgId: string,
    integrationName: string,
    postId: string
  ) {
    await this._notificationService.notifyFirstCommentUnsupported(
      orgId,
      integrationName,
      postId
    );
  }

  async notifyFirstCommentFailed(
    orgId: string,
    integrationName: string,
    postId: string
  ) {
    await this._notificationService.notifyFirstCommentFailed(
      orgId,
      integrationName,
      postId
    );
  }

  async notifyStreakReminder(orgId: string) {
    await this._notificationService.notifyStreakReminder(orgId);
  }

  async globalPlugs(integration: Integration) {
    return this._postService.checkPlugs(
      integration.organizationId,
      integration.providerIdentifier,
      integration.id
    );
  }

  async updatePostSettings(id: string, settings: string, orgId: string) {
    await this._postService.updatePostSettings(id, settings, orgId);
  }

  async changeState(id: string, state: State, orgId: string, err?: any, body?: any) {
    await this._postService.changeState(id, state, orgId, err, body);
  }

  async internalPlugs(integration: Integration, settings: any) {
    return this._postService.checkInternalPlug(
      integration,
      integration.organizationId,
      integration.id,
      settings
    );
  }

  async sendWebhooks(postId: string, orgId: string, integrationId: string, maxOccurrenceId?: string) {
    const webhooks = (await this._webhookService.getWebhooks(orgId)).filter(
      (f) => {
        return (
          (f.events.length === 0 || f.events.includes('post.published')) &&
          (f.integrations.length === 0 ||
            f.integrations.some((i) => i.id === integrationId))
        );
      }
    );

    const post = maxOccurrenceId
      ? await this._postService.maxWebhookSnapshot(postId, orgId, maxOccurrenceId)
      : await this._postService.getPostByForWebhookId(postId, orgId);
    if (maxOccurrenceId && !post) return;
    const root = Array.isArray(post) ? post[0] : post;

    // D4: stable, documented minimal subset — never ship the raw Prisma row.
    const envelope = {
      event: 'post.published',
      timestamp: new Date().toISOString(),
      data: {
        postId: root?.id ?? postId,
        ...(maxOccurrenceId ? { occurrenceId: maxOccurrenceId } : {}),
        integrationId,
        providerIdentifier: root?.integration?.providerIdentifier ?? null,
        integrationName: root?.integration?.name ?? null,
        content: root?.content ?? null,
        url: root?.releaseURL ?? null,
        state: root?.state ?? null,
        publishDate: root?.publishDate
          ? new Date(root.publishDate).toISOString()
          : null,
      },
    };
    const body = JSON.stringify(envelope);
    const signature = webhookSignature(body);

    // D4: bounded per-delivery retry (3 attempts, backoff). A flaky receiver is
    // retried without failing the others; final failure is swallowed so a bad
    // webhook never fails the publish. The whole call already runs inside a
    // durable Inngest `step.run('send-webhooks')`.
    await Promise.all(
      webhooks.map(async (webhook) => {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const res = await safeFetch(webhook.url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Postmill-Signature': signature,
              },
              body,
              signal: AbortSignal.timeout(webhookTimeoutMs()),
            });
            if (res.status >= 200 && res.status < 300) {
              return;
            }
          } catch (e) {
            /** retry below **/
          }
          if (attempt < 2) {
            await timer(1000 * (attempt + 1));
          }
        }
      })
    );
  }

  async processPlug(data: {
    plugId: string;
    postId: string;
    delay: number;
    totalRuns: number;
    currentRun: number;
  }) {
    return this._integrationService.processPlugs(data);
  }

  async processInternalPlug(data: {
    post: string;
    originalIntegration: string;
    integration: string;
    plugName: string;
    orgId: string;
    delay: number;
    information: any;
  }) {
    await this._integrationService.processInternalPlug(data);
  }

  async refreshToken(
    integration: Integration
  ): Promise<false | AuthTokenDetails> {
    // 2.5: the refresh needs the decrypted refreshToken, slimmed out of step state.
    integration = await this._withDecryptedIntegration(integration);

    const getIntegration = await this._integrationManager.getSocialIntegration(
      integration.providerIdentifier,
      integration.organizationId,
      integration.providerVersion
    );

    try {
      const refresh = await this._refreshIntegrationService.refresh(
        integration
      );
      if (!refresh) {
        return false;
      }

      if (getIntegration.refreshWait) {
        await timer(10000);
      }

      return refresh;
    } catch (err) {
      await this._refreshIntegrationService.setBetweenSteps(integration);
      return false;
    }
  }

  async refreshTokenWithCause(
    integration: Integration,
    cause: string
  ): Promise<false | AuthTokenDetails> {
    // 2.5: the refresh needs the decrypted refreshToken, slimmed out of step state.
    integration = await this._withDecryptedIntegration(integration);

    const getIntegration = await this._integrationManager.getSocialIntegration(
      integration.providerIdentifier,
      integration.organizationId,
      integration.providerVersion
    );

    try {
      const refresh = await this._refreshIntegrationService.refresh(
        integration,
        cause
      );
      if (!refresh) {
        return false;
      }

      if (getIntegration.refreshWait) {
        await timer(10000);
      }

      return refresh;
    } catch (err) {
      await this._refreshIntegrationService.setBetweenSteps(integration, cause);
      return false;
    }
  }


}
