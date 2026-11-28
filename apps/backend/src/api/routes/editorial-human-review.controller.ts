import {
  Controller, Get, Header, HttpCode, Inject, Param, Post, Body, Req, UseGuards, ForbiddenException, StreamableFile,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { GetOrgFromRequest } from '@postmill-ai/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@postmill-ai/nestjs-libraries/user/user.from.request';
import type { Organization, User } from '@prisma/client';
import { RequirePermission } from '@postmill-ai/backend/services/auth/rbac/require-permission.decorator';
import { OrgRbacGuard } from '@postmill-ai/backend/services/auth/rbac/org-rbac.guard';
import { EditorialHumanReviewService } from '@postmill-ai/backend/services/editorial/editorial-human-review.service';

// Registered only by the dormant EditorialHumanReviewModule, which applies
// the standard AuthMiddleware and CsrfMiddleware to these same routes.
// Body fields cannot assert actor, organization, target, text or image.
function sessionOnly(req: Request) {
  if (typeof req.cookies?.auth !== 'string' || !req.cookies.auth ||
      req.headers.auth !== undefined || req.headers.authorization !== undefined ||
      req.headers['x-api-key'] !== undefined ||
      req.cookies?.impersonate !== undefined || req.headers.impersonate !== undefined ||
      (typeof (req as Request & { authSource?: string }).authSource === 'string' &&
       (req as Request & { authSource?: string }).authSource !== 'cookie')) {
    throw new ForbiddenException('editorial_cookie_session_required');
  }
}

@ApiExcludeController()
@Controller('/editorial/review')
@UseGuards(OrgRbacGuard)
@Throttle({ default: { limit: 20, ttl: 60000 } })
export class EditorialHumanReviewController {
  constructor(@Inject(EditorialHumanReviewService) private readonly review: EditorialHumanReviewService) {}

  @Get(':postId/:taskId')
  @Header('Cache-Control', 'no-store')
  @RequirePermission('posts', 'read')
  read(
    @Req() req: Request,
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('postId') postId: string,
    @Param('taskId') taskId: string,
  ) {
    sessionOnly(req);
    return this.review.read(org.id, user.id, postId, taskId);
  }

  // POST rather than a public GET URL: requires the existing CSRF boundary.
  @Post(':postId/:taskId/live-image/preview')
  @HttpCode(200)
  @Header('Cache-Control','private, no-store')
  @Header('Pragma','no-cache')
  @Header('X-Content-Type-Options','nosniff')
  @Header('Cross-Origin-Resource-Policy','same-origin')
  @Header('Referrer-Policy','no-referrer')
  @RequirePermission('posts','read')
  async previewLiveImage(
    @Req() req:Request,
    @GetOrgFromRequest() org:Organization,
    @GetUserFromRequest() user:User,
    @Param('postId') postId:string,
    @Param('taskId') taskId:string,
    @Body() body:unknown,
  ) {
    sessionOnly(req);
    const bytes=await this.review.previewLiveImage(org.id,user.id,postId,taskId,body);
    return new StreamableFile(bytes,{type:'image/jpeg',length:bytes.length,disposition:'inline'});
  }

  @Post(':postId/:taskId/live-image/import')
  @HttpCode(200)
  @Header('Cache-Control','private, no-store')
  @RequirePermission('posts','update')
  importLiveImage(
    @Req() req:Request,
    @GetOrgFromRequest() org:Organization,
    @GetUserFromRequest() user:User,
    @Param('postId') postId:string,
    @Param('taskId') taskId:string,
    @Body() body:unknown,
  ) {
    sessionOnly(req);
    return this.review.importLiveImage(org.id,user.id,postId,taskId,body);
  }

  @Post(':postId/:taskId/live-image/decisions')
  @HttpCode(200)
  @Header('Cache-Control','private, no-store')
  @RequirePermission('posts','update')
  queueLiveImage(
    @Req() req:Request,
    @GetOrgFromRequest() org:Organization,
    @GetUserFromRequest() user:User,
    @Param('postId') postId:string,
    @Param('taskId') taskId:string,
    @Body() body:unknown,
  ) {
    sessionOnly(req);
    return this.review.queueLiveImage(org.id,user.id,postId,taskId,body);
  }

  @Post(':postId/:taskId/image/import')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RequirePermission('posts', 'update')
  importMockImage(
    @Req() req: Request,
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('postId') postId: string,
    @Param('taskId') taskId: string,
    @Body() body: unknown,
  ) {
    sessionOnly(req);
    return this.review.importMockImage(org.id,user.id,postId,taskId,body);
  }

  @Post(':postId/:taskId/decisions')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RequirePermission('posts', 'update')
  queue(
    @Req() req: Request,
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('postId') postId: string,
    @Param('taskId') taskId: string,
    @Body() body: unknown,
  ) {
    sessionOnly(req);
    return this.review.queue(org.id, user.id, postId, taskId, body);
  }
}
