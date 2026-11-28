import {
  ForbiddenException, HttpException, Inject, Injectable, NotFoundException, Optional,
} from '@nestjs/common';
import { PostsRepository } from '@postmill-ai/nestjs-libraries/database/prisma/posts/posts.repository';
import { PostsService } from '@postmill-ai/nestjs-libraries/database/prisma/posts/posts.service';
import { RolesService } from '@postmill-ai/nestjs-libraries/database/prisma/roles/roles.service';
import { AuditService } from '@postmill-ai/nestjs-libraries/database/prisma/audit/audit.service';
import { isEditorialTaskId } from '@postmill-ai/nestjs-libraries/database/prisma/posts/editorial-ingress';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { EditorialLiveImageService, liveImagePreviewEnabled } from './editorial-live-image.service';
import { mockImageImportEnabled } from './editorial-mock-image.service';

export const EDITORIAL_RELEASE_CONFIG = Symbol('EDITORIAL_RELEASE_CONFIG');
export type EditorialReleaseConfig = {
  enabled: true;
  testOrgId: string;
  targetInternalId: string;
};
export type EditorialReleaseCommand = {
  command_id: string;
  action: 'publish_now' | 'queue';
  publish_at: string | null;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const POST_ID = /^[0-9a-f]{32}$/;
const ISO_UTC_SLOT = /^20\d\d-\d\d-\d\dT\d\d:\d\d:00(?:\.000)?Z$/;
function record(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function checkCommand(x: unknown): EditorialReleaseCommand {
  if (!record(x) || Object.keys(x).length !== 3 ||
      !['command_id', 'action', 'publish_at'].every(k => Object.hasOwn(x, k)) ||
      typeof x.command_id !== 'string' || !UUID.test(x.command_id) ||
      (x.action !== 'publish_now' && x.action !== 'queue') ||
      (x.action === 'publish_now' ? x.publish_at !== null :
        typeof x.publish_at !== 'string' || !ISO_UTC_SLOT.test(x.publish_at) ||
        !Number.isFinite(Date.parse(x.publish_at)))) {
    throw new HttpException('editorial_release_invalid', 400);
  }
  return x as EditorialReleaseCommand;
}

function fromDb(error: unknown): never {
  const e = error as { code?: string; meta?: { code?: string } } | null;
  if (e?.code === 'P2010' && e.meta?.code === '55000')
    throw new HttpException('editorial_release_conflict', 409);
  if (e?.code === 'P2010' && e.meta?.code === '22023')
    throw new HttpException('editorial_release_invalid', 400);
  // After an unknown response the caller MUST perform a read-only GET; no
  // automatic duplicate POST even though SQL has a stable idempotency ledger.
  throw new HttpException('editorial_release_outcome_unknown', 503);
}

@Injectable()
export class EditorialReleaseService {
  constructor(
    @Inject(PostsRepository) private readonly posts: PostsRepository,
    @Inject(PostsService) private readonly postService: PostsService,
    @Inject(RolesService) private readonly roles: RolesService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EDITORIAL_RELEASE_CONFIG) private readonly config: EditorialReleaseConfig | null,
    @Optional() @Inject(EditorialLiveImageService) private readonly liveImages?: EditorialLiveImageService,
  ) {}

  private configFor(orgId: string): EditorialReleaseConfig {
    const c = this.config;
    if (!c || c.enabled !== true || c.testOrgId !== orgId ||
      !/^[A-Za-z0-9_.:-]{1,200}$/.test(c.testOrgId) ||
      typeof c.targetInternalId !== 'string' ||
      c.targetInternalId.length < 1 || c.targetInternalId.length > 200 ||
      c.targetInternalId.trim() !== c.targetInternalId) {
      throw new NotFoundException('editorial_release_disabled');
    }
    return c;
  }

  private validateIds(postId: string, taskId: string): void {
    if (!POST_ID.test(postId) || !isEditorialTaskId(taskId))
      throw new HttpException('editorial_release_invalid', 400);
  }

  private async authorize(orgId: string, userId: string, action: 'read' | 'update') {
    if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(userId))
      throw new ForbiddenException('editorial_cookie_session_required');
    const effective = await this.roles.getEffectivePermissions(orgId, userId);
    if (!effective || !(effective.permissions.includes('posts:manage') ||
      effective.permissions.includes('posts:' + action))) {
      throw new ForbiddenException('editorial_release_forbidden');
    }
  }

  private liveEnabled(cfg: EditorialReleaseConfig): boolean {
    return !!this.liveImages && cfg.testOrgId === 'org-modes' &&
      cfg.targetInternalId === 'max:-73052031470103' &&
      process.env.EDITORIAL_TEST_RELEASE_ENABLED === 'true' &&
      process.env.EDITORIAL_TEST_LIVE_IMAGE_RELEASE_ENABLED === 'true' &&
      process.env.EDITORIAL_TEST_LIVE_IMAGE_RELEASE_WORKER_ENABLED === '1' &&
      process.env.EDITORIAL_TEST_LIVE_IMAGE_HUMAN_ENABLED === 'true' &&
      liveImagePreviewEnabled(cfg.testOrgId,cfg.targetInternalId) &&
      !mockImageImportEnabled(cfg.testOrgId,cfg.targetInternalId);
  }

  // This is a separate queue-only route. All authority comes from the
  // committed local receipt + signed Engine current proof, never the body.
  private async liveEvidence(cfg: EditorialReleaseConfig, postId: string, taskId: string, view: unknown) {
    const deny = (): never => { throw new HttpException('editorial_live_release_conflict',409); };
    if (!this.liveEnabled(cfg)) throw new NotFoundException('editorial_live_release_disabled');
    const org=cfg.testOrgId,target=cfg.targetInternalId;
    if (!record(view) || !record(view.receipt) || !record(view.review) ||
        view.review_acknowledged!==true || view.review.status!=='idle' ||
        !record(view.review.last_confirmed_state)) return deny();
    const state=view.review.last_confirmed_state;
    if (state.final_approved!==true || state.rejected!==false || state.text_status!=='approved' ||
        state.image_mode!=='automatic' || state.image_compatible!==true || state.image_intent!==null ||
        state.text_request_id!==null || state.publishable!==false || state.dispatch_authorized!==false ||
        typeof state.seq!=='string' || !isEditorialTaskId(state.seq) || !record(state.image) ||
        !record(state.binding) || state.binding.org_id!==org || state.binding.post_id!==postId ||
        state.binding.task_id!==taskId || state.binding.is_test!==true ||
        state.binding.integration_id!=='mock-review-image-automatic' ||
        !isDeepStrictEqual(state.binding,view.receipt.binding) ||
        !isDeepStrictEqual(state.text,view.receipt.text) || view.receipt.image_mode!=='automatic') return deny();
    const ctx=await this.posts.readLiveImageContext(org,postId,taskId,target);
    if (!record(ctx) || ctx.status!=='idle' || !isDeepStrictEqual(ctx.state,state) ||
        ctx.publishable!==false || ctx.dispatch_authorized!==false ||
        !record(ctx.scope) || ctx.scope.org_id!==org || ctx.scope.is_test!==true ||
        ctx.scope.profile_ref!=='review-ci@v77' || ctx.scope.integration_id!=='mock-review-image-automatic' ||
        ctx.scope.campaign_id!=='mock-image-crossdb' || ctx.scope.image_mode!=='automatic' ||
        typeof ctx.scope.channel_id!=='string' || !isEditorialTaskId(ctx.scope.channel_id) ||
        !record(ctx.media) || !record(ctx.media.asset)) return deny();
    const media=ctx.media,asset=media.asset;
    if (!record(asset) || typeof asset.plan_id!=='string' || !UUID.test(asset.plan_id) ||
        typeof media.file_id!=='string' || !UUID.test(media.file_id) ||
        typeof asset.sha256!=='string' || !/^[0-9a-f]{64}$/.test(asset.sha256) ||
        media.sha256!==asset.sha256 || media.mime!=='image/jpeg' || asset.mime!=='image/jpeg' ||
        typeof media.size_bytes!=='number' || !Number.isSafeInteger(media.size_bytes) ||
        media.size_bytes<4 || media.size_bytes>8388608 || media.size_bytes!==asset.size_bytes ||
        media.revision!==state.image.revision) return deny();
    // Existing preview service checks the signed peer before/after real
    // private read + JPEG decode and rechecks the full native context.
    const verified=await this.liveImages!.preview(org,postId,taskId,target,state);
    if (!verified || verified.remote_current_verified!==true || verified.compatible!==true ||
        verified.publishable!==false || verified.dispatch_authorized!==false ||
        verified.file_id!==media.file_id || verified.revision!==media.revision ||
        verified.mime!=='image/jpeg' || verified.sha256!==asset.sha256 ||
        !Buffer.isBuffer(verified.bytes) || verified.bytes.length!==media.size_bytes ||
        createHash('sha256').update(verified.bytes).digest('hex')!==asset.sha256 ||
        !isDeepStrictEqual(ctx,await this.posts.readLiveImageContext(org,postId,taskId,target)) ||
        !this.liveEnabled(cfg)) return deny();
    return {state,ctx,pin:{plan_id:asset.plan_id,native_file_id:media.file_id,asset_sha256:asset.sha256},
      bytes:verified.bytes,integrationId:ctx.scope.integration_id};
  }

  async preview(orgId: string, userId: string, postId: string, taskId: string) {
    const cfg = this.configFor(orgId);
    this.validateIds(postId, taskId);
    await this.authorize(orgId, userId, 'read');
    let snapshot: unknown;
    try {
      snapshot = await this.posts.readEditorialHuman(orgId, postId, taskId, cfg.targetInternalId);
    } catch (e) { return fromDb(e); }
    if (!record(snapshot)) throw new NotFoundException('editorial_release_not_found');

    let existing;
    try {
      existing = await this.posts.readEditorialRelease(orgId, postId);
    } catch (e) { return fromDb(e); }
    if (existing) {
      return {
        ready: false, status: 'already_released',
        release_post_id: existing.publicationPostId,
        mode: existing.mode, publish_at: existing.publishAt.toISOString(),
        timezone: 'Europe/Moscow' as const,
      };
    }
    const view = snapshot as {
      receipt?: { binding?: { integration_id?: string }; image_mode?: string };
      review_acknowledged?: boolean;
      review?: {
        status?: string;
        last_confirmed_state?: {
          final_approved?: boolean; rejected?: boolean; image_mode?: string;
          text_status?: string;
        };
      };
    };
    const state = view.review?.last_confirmed_state;
    const ready = view.review_acknowledged === true && view.review?.status === 'idle' &&
      state?.final_approved === true && state?.rejected === false &&
      state?.image_mode === 'disabled' && state?.text_status === 'approved' &&
      view.receipt?.image_mode === 'disabled';
    if (!ready) {
      // Read-only, no native release or worker request from preview.
      if (view.receipt?.image_mode==='automatic' && this.liveEnabled(cfg)) {
        try {
          const proof=await this.liveEvidence(cfg,postId,taskId,snapshot);
          await this.authorize(orgId,userId,'read');
          const slot=await this.postService.previewEditorialStorySlot(orgId,proof.integrationId);
          if (!this.liveEnabled(cfg)) return {ready:false,status:'not_finally_approved'};
          return {ready:!!slot,status:slot?'available':'no_slot',next_slot:slot,allowed_actions:['queue']};
        } catch { return {ready:false,status:'not_finally_approved'}; }
      }
      return { ready: false, status: 'not_finally_approved' };
    }
    const integrationId = view.receipt?.binding?.integration_id;
    if (!integrationId) throw new HttpException('editorial_release_binding_unknown', 503);
    // Publish-now remains available without a configured grid. Only the
    // optional queue preview depends on free slots.
    let slot: Awaited<ReturnType<PostsService['previewEditorialStorySlot']>> | null = null;
    try {
      slot = await this.postService.previewEditorialStorySlot(orgId, integrationId);
    } catch {
      slot = null;
    }
    return { ready: true, status: 'available', next_slot: slot };
  }

  async release(
    orgId: string, userId: string, postId: string, taskId: string, input: unknown,
  ) {
    const cfg = this.configFor(orgId);
    this.validateIds(postId, taskId);
    const command = checkCommand(input);
    await this.authorize(orgId, userId, 'update');
    let raw: unknown;
    try {
      // Only the exact pilot can choose the live route. Legacy text-only SQL
      // remains authoritative and cannot release an image-bearing draft.
      if (orgId==='org-modes' && cfg.targetInternalId==='max:-73052031470103') {
        const view=await this.posts.readEditorialHuman(orgId,postId,taskId,cfg.targetInternalId);
        if (!record(view) || !record(view.receipt)) throw new NotFoundException('editorial_release_not_found');
        if (view.receipt.image_mode!=='disabled') {
          if (!this.liveEnabled(cfg)) throw new NotFoundException('editorial_live_release_disabled');
          if (command.action!=='queue' || typeof command.publish_at!=='string')
            throw new HttpException('editorial_live_release_queue_only',400);
          const proof=await this.liveEvidence(cfg,postId,taskId,view);
          await this.authorize(orgId,userId,'update');
          if (!isDeepStrictEqual(proof.ctx,await this.posts.readLiveImageContext(orgId,postId,taskId,cfg.targetInternalId)) ||
              !this.liveEnabled(cfg)) throw new HttpException('editorial_live_release_conflict',409);
          // No fallback or automatic retry after this native COMMIT boundary.
          raw=await this.posts.releaseLiveEditorialStory(orgId,postId,taskId,cfg.targetInternalId,userId,
            {command_id:command.command_id,action:'queue',publish_at:command.publish_at},
            proof.state,proof.pin,proof.bytes);
          if (!record(raw) || raw.source_post_id!==postId || raw.publication_post_id===postId ||
              raw.publishable!==false || raw.dispatch_authorized!==false ||
              typeof raw.publish_at!=='string' || Date.parse(raw.publish_at)!==Date.parse(command.publish_at) ||
              raw.status!==(raw.created===true?'recorded':'already_recorded'))
            throw new HttpException('editorial_release_outcome_unknown',503);
        } else {
          raw=await this.posts.releaseEditorialStory(orgId,postId,taskId,cfg.targetInternalId,userId,command);
        }
      } else {
        raw = await this.posts.releaseEditorialStory(
          orgId, postId, taskId, cfg.targetInternalId, userId, command,
        );
      }
    } catch (e) {
      if(e instanceof HttpException) throw e;
      return fromDb(e);
    }
    if (raw === null) throw new NotFoundException('editorial_release_not_found');
    if (!record(raw) || typeof raw.publication_post_id !== 'string' ||
        !POST_ID.test(raw.publication_post_id) ||
        typeof raw.created !== 'boolean' ||
        raw.mode !== command.action) {
      throw new HttpException('editorial_release_outcome_unknown', 503);
    }
    // Dispatch the SINGLE native Postmill MAX Story, not three separate posts.
    // If the process dies after SQL commit the existing MAX pending-occurrence
    // recovery reclaims due QUEUE posts; never repeat the release command.
    if (raw.created) {
      try {
        await this.postService.startWorkflow(
          'max', raw.publication_post_id, orgId, 'QUEUE',
          typeof raw.provider_version === 'string' ? raw.provider_version : undefined,
        );
      } catch {
        // A committed release is immutable. Do not retry the SQL release or
        // signal that MAX publication succeeded; recovery checks native state.
      }
      try {
        await this.audit.record({
          orgId, userId, action: 'editorial.story.release_queued',
          resource: 'post', resourceId: postId,
          metadata: { publicationPostId: raw.publication_post_id,
            mode: command.action, commandId: command.command_id },
        });
      } catch {
        // Best-effort audit should not replay a committed publishing intent.
      }
    }
    return {
      created: raw.created,
      status: raw.created ? 'native_dispatch_requested' : 'already_recorded',
      source_post_id: postId,
      publication_post_id: raw.publication_post_id,
      mode: raw.mode,
      publish_at: raw.publish_at,
      // A request is not confirmation from the MAX provider.
      max_delivery_confirmed: false,
    };
  }
}
