import {
  Controller, Get, Header, HttpCode, Inject, Param, Post, Body, Req,
  UseGuards, ForbiddenException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { Organization, User } from '@prisma/client';
import { GetOrgFromRequest } from '@postmill-ai/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@postmill-ai/nestjs-libraries/user/user.from.request';
import { RequirePermission } from '@postmill-ai/backend/services/auth/rbac/require-permission.decorator';
import { OrgRbacGuard } from '@postmill-ai/backend/services/auth/rbac/org-rbac.guard';
import { EditorialReleaseService } from '@postmill-ai/backend/services/editorial/editorial-release.service';

function sessionOnly(req: Request): void {
  if (typeof req.cookies?.auth !== 'string' || !req.cookies.auth ||
      req.headers.auth !== undefined || req.headers.authorization !== undefined ||
      req.headers['x-api-key'] !== undefined ||
      req.cookies?.impersonate !== undefined || req.headers.impersonate !== undefined ||
      (typeof (req as Request & { authSource?: string }).authSource === 'string' &&
       (req as Request & { authSource?: string }).authSource !== 'cookie')) {
    throw new ForbiddenException('editorial_cookie_session_required');
  }
}

// No public API/key auth, no route outside the dormant editorial module.
// Postmill still requires an explicit release command AFTER signed approval.
@ApiExcludeController()
@Controller('/editorial/release')
@UseGuards(OrgRbacGuard)
@Throttle({ default: { limit: 10, ttl: 60000 } })
export class EditorialReleaseController {
  constructor(@Inject(EditorialReleaseService) private readonly releases: EditorialReleaseService) {}

  @Get(':postId/:taskId/preview')
  @Header('Cache-Control', 'no-store')
  @RequirePermission('posts', 'read')
  preview(
    @Req() req: Request,
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('postId') postId: string,
    @Param('taskId') taskId: string,
  ) {
    sessionOnly(req);
    return this.releases.preview(org.id, user.id, postId, taskId);
  }

  @Post(':postId/:taskId')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RequirePermission('posts', 'update')
  release(
    @Req() req: Request,
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('postId') postId: string,
    @Param('taskId') taskId: string,
    @Body() body: unknown,
  ) {
    sessionOnly(req);
    return this.releases.release(org.id, user.id, postId, taskId, body);
  }
}
