import {
  Controller, Get, Header, HttpCode, Inject, Param, Post, Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { EditorialExchangeService } from '@postmill-ai/nestjs-libraries/database/prisma/posts/editorial-exchange.service';
import type {
  ExchangeConfiguration, ExchangeRequest,
} from '@postmill-ai/nestjs-libraries/database/prisma/posts/editorial-exchange.service';

export const EDITORIAL_EXCHANGE_CONFIG = Symbol('EDITORIAL_EXCHANGE_CONFIG');

function requestOf(req: RawBodyRequest<Request>): ExchangeRequest {
  return {
    authorization: req.headers.authorization,
    rawHeaders: req.rawHeaders,
    contentType: req.headers['content-type'],
    contentEncoding: req.headers['content-encoding'],
    queryPresent: req.originalUrl.includes('?'),
    rawBody: req.rawBody,
    body: req.body,
  };
}

// Private machine-only contract, not public SDK/OpenAPI.
// The module is intentionally NOT imported by runtime AppModule or ApiModule.
@ApiExcludeController()
@Controller('/internal/editorial/v1/drafts')
@Throttle({ default: { limit: 30, ttl: 60000 } })
export class EditorialExchangeController {
  constructor(
    @Inject(EditorialExchangeService) private readonly exchange: EditorialExchangeService,
    @Inject(EDITORIAL_EXCHANGE_CONFIG) private readonly config: ExchangeConfiguration | null,
  ) {}

  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  create(@Req() req: RawBodyRequest<Request>) {
    return this.exchange.create(requestOf(req), this.config);
  }

  @Get(':taskId')
  @Header('Cache-Control', 'no-store')
  read(@Param('taskId') taskId: string, @Req() req: RawBodyRequest<Request>) {
    return this.exchange.read(taskId, requestOf(req), this.config);
  }
}
