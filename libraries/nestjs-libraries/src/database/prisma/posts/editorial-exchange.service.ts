import { Inject, Injectable, HttpException } from '@nestjs/common';
import {
  authenticateEditorialMachine, EditorialIngressError, isEditorialTaskId, prepareEditorialDraft,
} from './editorial-ingress';
import { PostsRepository } from './posts.repository';

// Trusted configuration, never supplied by the machine request.
export type ExchangeConfiguration = { credential: unknown; targetInternalId: string };
export type ExchangeRequest = {
  authorization: unknown;
  rawHeaders: readonly string[];
  contentType: unknown;
  contentEncoding: unknown;
  queryPresent: boolean;
  rawBody?: Buffer;
  body: unknown;
};

function headerCount(headers: readonly string[], name: string): number {
  return headers.filter((value, i) => i % 2 === 0 && value.toLowerCase() === name).length;
}

function fromIngress(error: unknown): never {
  if (error instanceof EditorialIngressError) {
    throw new HttpException(error.code, error.code === 'unauthorized' ? 401 :
      error.code === 'scope_mismatch' ? 403 : 400);
  }
  throw new HttpException('exchange_outcome_unknown', 503);
}

function databaseError(error: unknown): never {
  // Prisma raw SQL SQLSTATE is exposed in P2010 meta.code. Never echo DB
  // messages, credentials, story text or parameters to client/logs.
  const e = error as { code?: unknown; meta?: { code?: unknown } } | null;
  if (e?.code === 'P2010' && e.meta?.code === '55000') {
    throw new HttpException('exchange_conflict', 409);
  }
  if (e?.code === 'P2010' && e.meta?.code === '22023') {
    throw new HttpException('invalid_request', 400);
  }
  throw new HttpException('exchange_outcome_unknown', 503);
}

@Injectable()
export class EditorialExchangeService {
  constructor(@Inject(PostsRepository) private readonly posts: PostsRepository) {}

  private authenticate(req: ExchangeRequest, config: ExchangeConfiguration | null) {
    if (!config || typeof config.targetInternalId !== 'string' ||
        config.targetInternalId.length < 1 || config.targetInternalId.length > 200 ||
        config.targetInternalId !== config.targetInternalId.trim() ||
        /[\u0000-\u001f\u007f]/u.test(config.targetInternalId) ||
        headerCount(req.rawHeaders, 'authorization') !== 1) {
      throw new HttpException('unauthorized', 401);
    }
    try {
      return authenticateEditorialMachine(req.authorization, config.credential);
    } catch (e) {
      return fromIngress(e);
    }
  }

  // Shared strict machine ingress for create and one-time pre-review install.
  // A raw JSON mismatch/duplicate key or a changed scope never reaches SQL.
  private preparedRequest(req: ExchangeRequest, config: ExchangeConfiguration | null) {
    this.authenticate(req, config);
    if (req.queryPresent || headerCount(req.rawHeaders, 'content-type') !== 1 ||
        typeof req.contentType !== 'string' ||
        !/^application\\/json(?:;\\s*charset=utf-8)?$/i.test(req.contentType) ||
        headerCount(req.rawHeaders, 'content-encoding') > 1 ||
        (req.contentEncoding !== undefined && req.contentEncoding !== 'identity') ||
        !Buffer.isBuffer(req.rawBody) || req.rawBody.length === 0 ||
        req.rawBody.length > 100000) {
      throw new HttpException('invalid_request', 400);
    }
    const canonical = JSON.stringify(req.body);
    if (typeof canonical !== 'string' || !Buffer.from(canonical, 'utf8').equals(req.rawBody)) {
      throw new HttpException('invalid_request', 400);
    }
    try {
      return prepareEditorialDraft(req.authorization, config!.credential, req.body);
    } catch (e) {
      return fromIngress(e);
    }
  }

  async create(req: ExchangeRequest, config: ExchangeConfiguration | null) {
    const prepared = this.preparedRequest(req, config);
    try {
      return await this.posts.exchangeCreateEditorialDraft(prepared, config!.targetInternalId);
    } catch (e) {
      return databaseError(e);
    }
  }

  // Same trusted private bearer and pinned test target as creation. The path
  // task must also match the canonical exact-body task ID. One install only.
  async installText(task: unknown, req: ExchangeRequest, config: ExchangeConfiguration | null) {
    const prepared = this.preparedRequest(req, config);
    if (!isEditorialTaskId(task) || task !== prepared.task_id) {
      throw new HttpException('invalid_request', 400);
    }
    try {
      return await this.posts.exchangeInstallEditorialText(prepared, config!.targetInternalId);
    } catch (e) {
      return databaseError(e);
    }
  }

  async read(task: unknown, req: ExchangeRequest, config: ExchangeConfiguration | null) {
    const scope = this.authenticate(req, config);
    if (!isEditorialTaskId(task) || req.queryPresent ||
        (req.rawBody && req.rawBody.length !== 0) ||
        headerCount(req.rawHeaders, 'content-length') > 0 ||
        headerCount(req.rawHeaders, 'transfer-encoding') > 0) {
      throw new HttpException('invalid_request', 400);
    }
    let result;
    try {
      result = await this.posts.exchangeReadEditorialDraft(scope, task, config!.targetInternalId);
    } catch (e) {
      return databaseError(e);
    }
    if (result === null) throw new HttpException('not_found', 404);
    return result;
  }
}
