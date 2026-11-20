import {
  Controller, Get, Header, HttpCode, Param, Post, Body, Req, UseGuards, ForbiddenException,
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

// Must remain in ApiModule.authenticatedController, where existing
// AuthMiddleware and CsrfMiddleware run. Body fields cannot assert actor,
// organization, target, text, image or entitlement.
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
  constructor(private readonly review: EditorialHumanReviewService) {}

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
