import { HttpException, Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { StorageProviderType } from '@prisma/client';
import { PostsRepository } from '@postmill-ai/nestjs-libraries/database/prisma/posts/posts.repository';
import { StorageService } from '@postmill-ai/nestjs-libraries/database/prisma/storage/storage.service';
import { EditorialPrivateImageStore } from '@postmill-ai/nestjs-libraries/database/prisma/posts/editorial-private-image';
import { fetchEditorialLiveImage, editorialWireConfig, type EditorialWireConfig, type EditorialLiveImageAsset } from '@postmill-ai/nestjs-libraries/database/prisma/posts/editorial-signed-transport';

import { validateEditorialLiveJpeg } from '@postmill-ai/nestjs-libraries/database/prisma/posts/editorial-live-jpeg';
const TARGET = 'max:-73052031470103';
const ORG = 'org-modes';
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function record(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}
function unavailable(): never { throw new HttpException('editorial_image_import_outcome_unknown', 503); }

export function liveImageImportEnabled(org: string, target: string,
  env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return org === ORG && target === TARGET && env.EDITORIAL_TEST_SESSION_ENABLED === 'true' &&
    env.EDITORIAL_TEST_ORG_ID === ORG && env.EDITORIAL_TEST_MAX_TARGET === TARGET &&
    env.EDITORIAL_TEST_LIVE_IMAGE_IMPORT_ENABLED === 'true';
}
function wireConfig(): EditorialWireConfig {
  const wire = {
    orgId: ORG,
    allowLiveImageRead: true,
    requestKeyHex: readFileSync('/run/secrets/postmill_editorial_request_hmac_hex', 'utf8').trim(),
    responseKeyHex: readFileSync('/run/secrets/postmill_editorial_response_hmac_hex', 'utf8').trim(),
  };
  editorialWireConfig(wire);
  return wire;
}

// Explicit test-target service, intentionally not registered in a module. No background sweep, no paid operation,
// no publication. Bytes are stored outside the public LOCAL adapter namespace.
// Metadata and File row commit together in the SQL receipt transaction.
@Injectable()
export class EditorialLiveImageService {
  constructor(@Inject(PostsRepository) private readonly posts: PostsRepository,
    @Inject(StorageService) private readonly storage: StorageService) {}

  private async readBytes(store: EditorialPrivateImageStore, key: string, asset: EditorialLiveImageAsset): Promise<Buffer> {
    const bytes=await store.read(key,asset.size_bytes);
    await validateEditorialLiveJpeg(bytes,asset);
    return bytes;
  }

  // Internal only; a future cookie+RBAC authorized binary endpoint must
  // enforce the exact native review grant and must not expose storage URLs.
  // This is a locally confirmed preview, NOT a remote-current proof.
  async preview(org: string, pid: string, task: string, target: string, currentState: unknown) {
    if (!liveImageImportEnabled(org,target) ||
        process.env.EDITORIAL_TEST_LIVE_IMAGE_PREVIEW_ENABLED !== 'true') return undefined;
    try {
      const ctx = await this.posts.readLiveImageContext(org,pid,task,target);
      if (!record(ctx) || !record(ctx.state) || !record(ctx.scope) ||
          ctx.scope.org_id !== org || ctx.status !== 'idle' ||
          !record(currentState) || !isDeepStrictEqual(ctx.state,currentState) ||
          ctx.state.rejected !== false || !record(ctx.state.image) ||
          !record(ctx.media)) unavailable();
      const m = ctx.media;
      const a = m.asset;
      if (!record(a) || typeof m.path !== 'string' || typeof m.file_id !== 'string' ||
          !UUID.test(m.file_id) || typeof a.asset_id !== 'string' || !UUID.test(a.asset_id) ||
          typeof a.plan_id !== 'string' || !UUID.test(a.plan_id) ||
          typeof a.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(a.sha256) ||
          typeof a.size_bytes !== 'number' || !Number.isSafeInteger(a.size_bytes) ||
          a.size_bytes < 4 || a.size_bytes > 8*1024*1024 ||
          m.sha256 !== a.sha256 || m.size_bytes !== a.size_bytes || m.mime !== 'image/jpeg' ||
          m.revision !== ctx.state.image.revision || typeof m.revision !== 'number' ||
          !Number.isSafeInteger(m.revision) || m.revision < 1 ||
          typeof ctx.state.image_compatible !== 'boolean') unavailable();
      const bytes=await this.readBytes(await EditorialPrivateImageStore.open(),m.path,a as unknown as EditorialLiveImageAsset);
      // Verify the entire DB snapshot and native receipt again after IO.
      // No database lock is held across read/decode.
      const latest=await this.posts.readLiveImageContext(org,pid,task,target);
      if (!isDeepStrictEqual(ctx,latest)) unavailable();
      return {bytes,mime:'image/jpeg' as const,file_id:m.file_id,revision:m.revision,
        sha256:a.sha256,compatible:ctx.state.image_compatible,
        remote_current_verified:false as const,publishable:false as const,dispatch_authorized:false as const};
    } catch {
      // Never include paths or raw storage exceptions in preview failures.
      throw new HttpException('editorial_image_preview_unavailable',503);
    }
  }

  async import(org: string, pid: string, task: string, target: string, seq: string,
    wire: () => EditorialWireConfig = wireConfig, fetchImage = fetchEditorialLiveImage) {
    if (!liveImageImportEnabled(org,target)) throw new HttpException('editorial_image_import_disabled',404);
    try {
      const ctx = await this.posts.readLiveImageContext(org,pid,task,target);
      if (!record(ctx) || !record(ctx.state) || !record(ctx.scope) || ctx.state.seq !== seq ||
          ctx.scope.org_id !== org || typeof ctx.scope.channel_id !== 'string' ||
          ctx.state.rejected !== false) throw new HttpException('editorial_image_import_conflict',409);
      if (ctx.status === 'image_import_uncertain') return {status:'uncertain',publishable:false,dispatch_authorized:false};
      if (ctx.status !== 'idle' || ctx.state.image_compatible !== false ||
          typeof ctx.state.image_intent !== 'string') throw new HttpException('editorial_image_import_conflict',409);
      const request = {org_id:org,task_id:task,channel_id:ctx.scope.channel_id,state:ctx.state};
      const config = wire();
      const fetched = await fetchImage(request,config);
      if (!fetched) return {status:'not_ready',publishable:false,dispatch_authorized:false};
      const asset=fetched.proof.manifest[0];
      await validateEditorialLiveJpeg(fetched.bytes,asset);
      const adapter = await this.storage.getBaseAdapterForOrg(org);
      if (adapter.type !== StorageProviderType.LOCAL) unavailable();
      const privateStore = await EditorialPrivateImageStore.open();
      await this.storage.assertWithinProviderQuota(adapter,org,fetched.bytes.length,null);
      // Standalone SQL query commits before the only private write invocation.
      const claim = await this.posts.reserveLiveImageImport(org,pid,task,target,fetched.proof);
      if (!record(claim) || claim.publishable !== false || claim.dispatch_authorized !== false) unavailable();
      if (claim.status === 'recorded' || claim.status === 'uncertain') return {status:claim.status,publishable:false,dispatch_authorized:false};
      if (claim.status !== 'reserved' || typeof claim.import_id !== 'string' || !UUID.test(claim.import_id) ||
          typeof claim.token !== 'string' || !UUID.test(claim.token)) unavailable();
      // The remote state can advance while a local reservation/storage write
      // is in flight. Recheck the same authenticated proof before the only
      // write and again after read-back. This narrows the race, not a
      // distributed atomic commit. A mismatch leaves the reservation blocked.
      const recheck = async () => {
        const current = await fetchImage(request,config);
        if (!current || !current.bytes.equals(fetched.bytes) ||
            !isDeepStrictEqual(current.proof,fetched.proof)) unavailable();
      };
      await recheck();
      const path = await privateStore.write(claim.import_id,fetched.bytes);
      const verified = await this.readBytes(privateStore,path,asset);
      if (!verified.equals(fetched.bytes)) unavailable();
      await recheck();
      const receipt = await this.posts.finishLiveImageImport(org,pid,task,target,claim.import_id,
        claim.token,path,digest(verified),verified.length);
      if (!record(receipt) || receipt.status !== 'recorded' || receipt.publishable !== false ||
          receipt.dispatch_authorized !== false || typeof receipt.file_id !== 'string') unavailable();
      return {status:'recorded',publishable:false,dispatch_authorized:false};
    } catch (error) {
      // Never remove/rewrite after unknown storage or DB outcome. No logs with
      // secrets, proof, bytes, storage paths or exception details.
      if (error instanceof HttpException && error.getStatus() === 409) throw error;
      return unavailable();
    }
  }
}
