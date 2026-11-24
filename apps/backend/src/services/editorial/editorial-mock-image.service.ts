import { HttpException, Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { StorageProviderType } from '@prisma/client';
import { PostsRepository } from '@postmill-ai/nestjs-libraries/database/prisma/posts/posts.repository';
import { StorageService } from '@postmill-ai/nestjs-libraries/database/prisma/storage/storage.service';
import { IStorageAdapter } from '@postmill-ai/nestjs-libraries/upload/upload.interface';
import { fetchEditorialMockImage, editorialWireConfig, type EditorialWireConfig } from '@postmill-ai/nestjs-libraries/database/prisma/posts/editorial-signed-transport';

const TARGET = 'max:-73052031470103';
const ORG = 'org-modes';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNUNPdlYGBgYmBgYGBgAAAHugCprKZFeAAAAABJRU5ErkJggg==','base64');
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const SHA = digest(PNG);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PATH = /^(https?:\/\/[^/?#\s]+)?\/uploads\/org-modes\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f]{32}\.png$/;
function record(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}
function unavailable(): never { throw new HttpException('editorial_image_import_outcome_unknown', 503); }

export function mockImageImportEnabled(org: string, target: string,
  env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return org === ORG && target === TARGET && env.EDITORIAL_TEST_SESSION_ENABLED === 'true' &&
    env.EDITORIAL_TEST_ORG_ID === ORG && env.EDITORIAL_TEST_MAX_TARGET === TARGET &&
    env.EDITORIAL_TEST_MOCK_IMAGE_IMPORT_ENABLED === 'true';
}
function wireConfig(): EditorialWireConfig {
  const wire = {
    orgId: ORG,
    requestKeyHex: readFileSync('/run/secrets/postmill_editorial_request_hmac_hex', 'utf8').trim(),
    responseKeyHex: readFileSync('/run/secrets/postmill_editorial_response_hmac_hex', 'utf8').trim(),
  };
  editorialWireConfig(wire);
  return wire;
}

// Explicit, fixture-only service. No background sweep, no paid operation,
// no publication. All byte writes go through the normal native LOCAL adapter.
// Metadata and File row commit together in the SQL receipt transaction.
@Injectable()
export class EditorialMockImageService {
  constructor(@Inject(PostsRepository) private readonly posts: PostsRepository,
    @Inject(StorageService) private readonly storage: StorageService) {}

  private async adapter(org: string): Promise<IStorageAdapter> {
    const adapter = await this.storage.getBaseAdapterForOrg(org);
    if (adapter.type !== StorageProviderType.LOCAL) unavailable();
    return adapter;
  }

  private async readBytes(adapter: IStorageAdapter, path: string): Promise<Buffer> {
    if (!PATH.test(path)) unavailable();
    const stream = await adapter.readFileStream(path);
    const chunks: Buffer[] = [];
    let count = 0;
    try {
      for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        count += bytes.length;
        if (count > PNG.length) unavailable();
        chunks.push(bytes);
      }
    } finally { stream.destroy(); }
    const bytes = Buffer.concat(chunks, count);
    if (!bytes.equals(PNG)) unavailable();
    return bytes;
  }

  async preview(org: string, pid: string, task: string, target: string, currentState: unknown) {
    if (!mockImageImportEnabled(org, target)) return undefined;
    try {
      const ctx = await this.posts.readMockImageContext(org,pid,task,target);
      if (!record(ctx) || !record(ctx.state) || !record(currentState) ||
          ctx.state.seq !== currentState.seq) return undefined;
      const s = ctx.state;
      const canImport = ctx.status === 'idle' && s.rejected === false && s.final_approved === false &&
        s.image_compatible === false && typeof s.image_intent === 'string' &&
        ['pending','approved'].includes(s.text_status as string) &&
        (s.image_mode !== 'after_text_approval' || s.text_status === 'approved');
      if (ctx.media === null) return { status: ctx.status === 'image_import_uncertain' ? 'uncertain' : 'waiting',
        can_import: canImport, asset: null };
      const m = ctx.media;
      if (!record(m) || typeof m.path !== 'string' || typeof m.file_id !== 'string' || !UUID.test(m.file_id) ||
          m.sha256 !== SHA || m.size_bytes !== PNG.length || m.mime !== 'image/png' ||
          !record(s.image) || m.revision !== s.image.revision) unavailable();
      const bytes = await this.readBytes(await this.adapter(org),m.path);
      return {status: ctx.status === 'image_import_uncertain' ? 'uncertain' : 'recorded',
        can_import: canImport, asset: {file_id:m.file_id, revision:m.revision, sha256:SHA,
          compatible:s.image_compatible === true, png_base64:bytes.toString('base64')}};
    } catch { return {status:'unavailable',can_import:false,asset:null}; }
  }

  async import(org: string, pid: string, task: string, target: string, seq: string,
    wire: () => EditorialWireConfig = wireConfig, fetchImage = fetchEditorialMockImage) {
    if (!mockImageImportEnabled(org,target)) throw new HttpException('editorial_image_import_disabled',404);
    try {
      const ctx = await this.posts.readMockImageContext(org,pid,task,target);
      if (!record(ctx) || !record(ctx.state) || !record(ctx.scope) || ctx.state.seq !== seq ||
          ctx.scope.org_id !== org || typeof ctx.scope.channel_id !== 'string' ||
          ctx.state.rejected !== false) throw new HttpException('editorial_image_import_conflict',409);
      if (ctx.status === 'image_import_uncertain') return {status:'uncertain',publishable:false,dispatch_authorized:false};
      if (ctx.status !== 'idle' || ctx.state.image_compatible !== false ||
          typeof ctx.state.image_intent !== 'string') throw new HttpException('editorial_image_import_conflict',409);
      const fetched = await fetchImage({org_id:org,task_id:task,channel_id:ctx.scope.channel_id,state:ctx.state},wire());
      if (!fetched) return {status:'not_ready',publishable:false,dispatch_authorized:false};
      if (!fetched.bytes.equals(PNG)) unavailable();
      const adapter = await this.adapter(org);
      await this.storage.assertWithinProviderQuota(adapter,org,fetched.bytes.length,null);
      // Standalone SQL query commits before the only writeBuffer invocation.
      const claim = await this.posts.reserveMockImageImport(org,pid,task,target,fetched.proof);
      if (!record(claim) || claim.publishable !== false || claim.dispatch_authorized !== false) unavailable();
      if (claim.status === 'recorded' || claim.status === 'uncertain') return {status:claim.status,publishable:false,dispatch_authorized:false};
      if (claim.status !== 'reserved' || typeof claim.import_id !== 'string' || !UUID.test(claim.import_id) ||
          typeof claim.token !== 'string' || !UUID.test(claim.token)) unavailable();
      const path = await adapter.writeBuffer(fetched.bytes,'image/png');
      const verified = await this.readBytes(adapter,path);
      const receipt = await this.posts.finishMockImageImport(org,pid,task,target,claim.import_id,
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
