import { ForbiddenException, HttpException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PostsRepository } from '@postmill-ai/nestjs-libraries/database/prisma/posts/posts.repository';
import { RolesService } from '@postmill-ai/nestjs-libraries/database/prisma/roles/roles.service';
import { AuditService } from '@postmill-ai/nestjs-libraries/database/prisma/audit/audit.service';
import { isEditorialTaskId } from '@postmill-ai/nestjs-libraries/database/prisma/posts/editorial-ingress';

import { EditorialLiveImageService,liveImagePreviewEnabled } from './editorial-live-image.service';
import { EditorialMockImageService, mockImageImportEnabled } from './editorial-mock-image.service';

export const EDITORIAL_HUMAN_REVIEW_CONFIG = Symbol('EDITORIAL_HUMAN_REVIEW_CONFIG');
export type EditorialHumanReviewConfig = {
  enabled: true;
  testOrgId: string;
  targetInternalId: string;
};
type Action = 'approve_text' | 'request_text_changes' | 'reject' | 'request_image' | 'request_image_changes' | 'confirm_image_reuse' | 'approve_final';
export type HumanCommand = { command_id: string; expected_seq: string; action: Action; feedback: string };
const POST_ID = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SEQ = /^(0|[1-9][0-9]{0,18})$/;
const ACTIONS: Action[] = ['approve_text', 'request_text_changes', 'reject', 'request_image', 'request_image_changes', 'confirm_image_reuse', 'approve_final'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function checkedCommand(value: unknown): HumanCommand {
  if (!isRecord(value) || Object.keys(value).length !== 4 ||
      !['command_id', 'expected_seq', 'action', 'feedback'].every((k) => Object.hasOwn(value, k)) ||
      typeof value.command_id !== 'string' || !UUID.test(value.command_id) ||
      typeof value.expected_seq !== 'string' || !SEQ.test(value.expected_seq) ||
      (value.expected_seq.length === 19 && value.expected_seq > '9223372036854775807') ||
      typeof value.action !== 'string' || !ACTIONS.includes(value.action as Action) ||
      typeof value.feedback !== 'string' || value.feedback.length > 4000 ||
      Buffer.byteLength(value.feedback, 'utf8') > 16000 ||
      (['request_text_changes','request_image_changes'].includes(value.action) ? !/\S/u.test(value.feedback) : value.feedback !== '')) {
    throw new HttpException('editorial_invalid_command', 400);
  }
  return value as HumanCommand;
}
function fromDatabase(error: unknown): never {
  const e = error as { code?: string; meta?: { code?: string } } | null;
  if (e?.code === 'P2010' && e.meta?.code === '55000') {
    throw new HttpException('editorial_review_conflict', 409);
  }
  if (e?.code === 'P2010' && e.meta?.code === '22023') {
    throw new HttpException('editorial_invalid_request', 400);
  }
  throw new HttpException('editorial_review_outcome_unknown', 503);
}

// Deliberately not an AI trigger, remote dispatcher, or publication service.
// Production configuration is null. A later reviewed enablement must supply
// the exact test organization + trusted native MAX target.
@Injectable()
export class EditorialHumanReviewService {
  constructor(
    @Inject(PostsRepository) private readonly posts: PostsRepository,
    @Inject(RolesService) private readonly roles: RolesService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EDITORIAL_HUMAN_REVIEW_CONFIG) private readonly config: EditorialHumanReviewConfig | null,
    @Optional() @Inject(EditorialMockImageService) private readonly images?: EditorialMockImageService,
    @Optional() @Inject(EditorialLiveImageService) private readonly liveImages?: EditorialLiveImageService,
  ) {}

  private configFor(orgId: string): EditorialHumanReviewConfig {
    const c = this.config;
    if (!c || c.enabled !== true ||
        c.testOrgId !== orgId || c.testOrgId.length > 200 ||
        !/^[A-Za-z0-9_.:-]+$/.test(c.testOrgId) ||
        typeof c.targetInternalId !== 'string' ||
        c.targetInternalId.length < 1 || c.targetInternalId.length > 200 ||
        c.targetInternalId.trim() !== c.targetInternalId) {
      throw new NotFoundException('editorial_review_disabled');
    }
    return c;
  }

  private async authorize(orgId: string, userId: string, action: 'read' | 'update') {
    if (!userId || !/^[A-Za-z0-9_.:-]{1,200}$/.test(userId)) {
      throw new ForbiddenException('editorial_session_required');
    }
    // Explicit membership and permissions even for a platform super-admin:
    // OrgRbacGuard normally bypasses super-admins and public-API credentials.
    const effective = await this.roles.getEffectivePermissions(orgId, userId);
    const permissions = effective?.permissions ?? [];
    if (!effective || !(permissions.includes('posts:manage') ||
      permissions.includes('posts:' + action))) {
      throw new ForbiddenException('editorial_not_authorized');
    }
  }

  private validateIds(postId: string, taskId: string) {
    if (!POST_ID.test(postId) || !isEditorialTaskId(taskId)) {
      throw new HttpException('editorial_invalid_request', 400);
    }
  }

  async read(orgId: string, userId: string, postId: string, taskId: string) {
    const cfg = this.configFor(orgId);
    this.validateIds(postId, taskId);
    await this.authorize(orgId, userId, 'read');
    let result: unknown;
    try {
      result = await this.posts.readEditorialHuman(orgId, postId, taskId, cfg.targetInternalId);
    } catch (e) { return fromDatabase(e); }
    if (result === null) throw new NotFoundException('editorial_review_not_found');
    if (this.images && isRecord(result) && isRecord(result.review)) {
      const image = await this.images.preview(orgId,postId,taskId,cfg.targetInternalId,result.review.last_confirmed_state);
      if (image !== undefined) return {...result,mock_image:image};
    }
    return result;
  }

  async previewLiveImage(orgId:string,userId:string,postId:string,taskId:string,body:unknown) {
    const cfg=this.configFor(orgId);
    this.validateIds(postId,taskId);
    await this.authorize(orgId,userId,'read');
    if (!this.liveImages || !liveImagePreviewEnabled(orgId,cfg.targetInternalId))
      throw new NotFoundException('editorial_image_preview_disabled');
    if (!isRecord(body) || Object.keys(body).length!==1 || typeof body.expected_seq!=='string' ||
        !SEQ.test(body.expected_seq) || (body.expected_seq.length===19 && body.expected_seq>'9223372036854775807'))
      throw new HttpException('editorial_invalid_request',400);
    let view:unknown;
    try { view=await this.posts.readEditorialHuman(orgId,postId,taskId,cfg.targetInternalId); }
    catch(e) { return fromDatabase(e); }
    if (!isRecord(view) || !isRecord(view.review) || view.review.status!=='idle' ||
        !isRecord(view.review.last_confirmed_state) || view.review.last_confirmed_state.seq!==body.expected_seq)
      throw new HttpException('editorial_review_conflict',409);
    const preview=await this.liveImages.preview(orgId,postId,taskId,cfg.targetInternalId,view.review.last_confirmed_state);
    if (!preview || preview.remote_current_verified!==true) throw new HttpException('editorial_image_preview_unavailable',503);
    // Membership may have changed during the bounded I/O.
    await this.authorize(orgId,userId,'read');
    if (!liveImagePreviewEnabled(orgId,cfg.targetInternalId)) throw new NotFoundException('editorial_image_preview_disabled');
    return preview.bytes;
  }

  async importMockImage(orgId: string, userId: string, postId: string, taskId: string, body: unknown) {
    const cfg = this.configFor(orgId);
    this.validateIds(postId,taskId);
    await this.authorize(orgId,userId,'update');
    if (!this.images) throw new NotFoundException('editorial_image_import_disabled');
    if (!isRecord(body) || Object.keys(body).length !== 1 ||
        typeof body.expected_seq !== 'string' || !SEQ.test(body.expected_seq) ||
        (body.expected_seq.length === 19 && body.expected_seq > '9223372036854775807')) {
      throw new HttpException('editorial_invalid_command',400);
    }
    return this.images.import(orgId,postId,taskId,cfg.targetInternalId,body.expected_seq);
  }

  async queue(orgId: string, userId: string, postId: string, taskId: string, body: unknown) {
    const cfg = this.configFor(orgId);
    this.validateIds(postId, taskId);
    const command = checkedCommand(body);
    await this.authorize(orgId, userId, 'update');
    if (['request_image_changes','confirm_image_reuse','approve_final'].includes(command.action)) {
      if (!this.images || !mockImageImportEnabled(orgId,cfg.targetInternalId)) {
        throw new NotFoundException('editorial_image_review_disabled');
      }
      const image = await this.images.preview(orgId,postId,taskId,cfg.targetInternalId,{seq:command.expected_seq});
      if (image?.status !== 'recorded' || !image.asset ||
          (command.action === 'confirm_image_reuse' && image.asset.compatible) ||
          (command.action === 'approve_final' && !image.asset.compatible)) {
        throw new HttpException('editorial_image_review_conflict',409);
      }
    }
    let result: unknown;
    try {
      result = await this.posts.queueEditorialHuman(orgId, postId, taskId,
        cfg.targetInternalId, userId, command);
    } catch (e) { return fromDatabase(e); }
    if (result === null) throw new NotFoundException('editorial_review_not_found');
    const response = result as { status: string; event_id: string; replay: boolean };
    // Never log content, feedback, bridge credentials or raw SQL messages.
    try {
      await this.audit.record({
        orgId, userId, action: 'editorial.review.queued',
        resource: 'post', resourceId: postId,
        metadata: { taskId, eventId: response.event_id,
          commandId: command.command_id, action: command.action, replay: response.replay },
      });
    } catch {
      // Existing Postmill audit convention: best effort, not a reason to
      // repeat an already committed immutable decision.
    }
    return result;
  }
}
