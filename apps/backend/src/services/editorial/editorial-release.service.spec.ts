import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorialReleaseService } from './editorial-release.service';
import { createHash } from 'node:crypto';

const orgId = 'ci-org';
const userId = 'ci-editor';
const postId = 'a'.repeat(32);
const taskId = '804';
const commandId = '11111111-1111-4111-8111-111111111111';
const publicationId = 'b'.repeat(32);
const cmd = { command_id: commandId, action: 'publish_now' as const, publish_at: null };
const release = {
  created: true, source_post_id: postId, publication_post_id: publicationId,
  mode: 'publish_now', provider_version: 'v1', publish_at: '2026-11-21T10:00:00.000Z',
};

describe('Editorial 09B explicit release — default disabled, no duplicates', () => {
  const posts = {
    readEditorialHuman: vi.fn(),
    readEditorialRelease: vi.fn(),
    releaseEditorialStory: vi.fn(),
  };
  const postService = {
    previewEditorialStorySlot: vi.fn(),
    startWorkflow: vi.fn(),
  };
  const roles = { getEffectivePermissions: vi.fn() };
  const audit = { record: vi.fn() };
  let service: EditorialReleaseService;

  beforeEach(() => {
    vi.resetAllMocks();
    roles.getEffectivePermissions.mockResolvedValue({ permissions: ['posts:read', 'posts:update'] });
    posts.releaseEditorialStory.mockResolvedValue(release);
    posts.readEditorialRelease.mockResolvedValue(null);
    posts.readEditorialHuman.mockResolvedValue({
      review_acknowledged: true,
      receipt: { image_mode: 'disabled', binding: { integration_id: 'integration-test' } },
      review: { status: 'idle', last_confirmed_state: {
        final_approved: true, rejected: false,
        text_status: 'approved', image_mode: 'disabled',
      } },
    });
    postService.previewEditorialStorySlot.mockResolvedValue({
      integrationId: 'integration-test',
      timezone: 'Europe/Moscow',
      localTime: '2026-11-22 08:00',
      publishAt: '2026-11-22T05:00:00.000Z',
    });
    postService.startWorkflow.mockResolvedValue(undefined);
    audit.record.mockResolvedValue(undefined);
    service = new EditorialReleaseService(
      posts as never, postService as never, roles as never, audit as never,
      { enabled: true, testOrgId: orgId, targetInternalId: 'max:-999' },
    );
  });

  it('does not allow even a preview or release in production default-disabled configuration', async () => {
    const off = new EditorialReleaseService(
      posts as never, postService as never, roles as never, audit as never, null,
    );
    await expect(off.preview(orgId, userId, postId, taskId)).rejects.toMatchObject({ status: 404 });
    await expect(off.release(orgId, userId, postId, taskId, cmd))
      .rejects.toMatchObject({ status: 404 });
    expect(posts.releaseEditorialStory).not.toHaveBeenCalled();
    expect(postService.startWorkflow).not.toHaveBeenCalled();
  });

  it('one explicit publish-now click creates one native story and requests one worker workflow', async () => {
    const result = await service.release(orgId, userId, postId, taskId, cmd);
    expect(posts.releaseEditorialStory).toHaveBeenCalledExactlyOnceWith(
      orgId, postId, taskId, 'max:-999', userId, cmd,
    );
    expect(postService.startWorkflow).toHaveBeenCalledExactlyOnceWith(
      'max', publicationId, orgId, 'QUEUE', 'v1',
    );
    expect(result).toMatchObject({
      created: true, mode: 'publish_now',
      status: 'native_dispatch_requested', max_delivery_confirmed: false,
      publication_post_id: publicationId,
    });
  });

  it('a confirmed SQL replay never emits a second workflow event', async () => {
    posts.releaseEditorialStory.mockResolvedValueOnce({
      ...release, created: false,
    });
    const result = await service.release(orgId, userId, postId, taskId, cmd);
    expect(result.status).toBe('already_recorded');
    expect(postService.startWorkflow).not.toHaveBeenCalled();
  });

  it('queue command forwards one exact Moscow-grid UTC slot, not three different posts', async () => {
    const scheduled = { command_id: commandId, action: 'queue' as const,
      publish_at: '2026-11-22T05:00:00.000Z' };
    posts.releaseEditorialStory.mockResolvedValueOnce({
      ...release, mode: 'queue', created: true,
    });
    const result = await service.release(orgId, userId, postId, taskId, scheduled);
    expect(result.created).toBe(true);
    expect(posts.releaseEditorialStory).toHaveBeenCalledWith(
      orgId, postId, taskId, 'max:-999', userId, scheduled,
    );
    expect(postService.startWorkflow).toHaveBeenCalledTimes(1);
    expect(postService.startWorkflow.mock.calls[0][1]).toBe(publicationId);
  });

  it('read-only preview needs final approval, and reports one next whole-story slot', async () => {
    const result = await service.preview(orgId, userId, postId, taskId);
    expect(result).toMatchObject({
      ready: true, status: 'available',
      next_slot: { localTime: '2026-11-22 08:00', timezone: 'Europe/Moscow' },
    });
    expect(postService.previewEditorialStorySlot).toHaveBeenCalledWith(
      orgId, 'integration-test',
    );
    expect(postService.startWorkflow).not.toHaveBeenCalled();
    posts.readEditorialHuman.mockResolvedValueOnce({
      review_acknowledged: true, review: { status: 'pending' },
    });
    expect(await service.preview(orgId, userId, postId, taskId))
      .toMatchObject({ ready: false, status: 'not_finally_approved' });
  });

  it('rejects extra fields, invalid dates, unauthorized actors or foreign orgs before SQL', async () => {
    await expect(service.release(orgId, userId, postId, taskId,
      { ...cmd, actor_id: 'injected' })).rejects.toMatchObject({ status: 400 });
    await expect(service.release(orgId, userId, postId, taskId,
      { ...cmd, action: 'queue', publish_at: '2026-11-22T05:00:00+03:00' }))
      .rejects.toMatchObject({ status: 400 });
    roles.getEffectivePermissions.mockResolvedValueOnce({ permissions: ['posts:read'] });
    await expect(service.release(orgId, userId, postId, taskId, cmd))
      .rejects.toMatchObject({ status: 403 });
    await expect(service.release('other-org', userId, postId, taskId, cmd))
      .rejects.toMatchObject({ status: 404 });
    expect(posts.releaseEditorialStory).not.toHaveBeenCalled();
  });

  it('does not retry SQL or claim confirmed publication on an unknown database response', async () => {
    posts.releaseEditorialStory.mockRejectedValueOnce(new Error('unknown DB result'));
    await expect(service.release(orgId, userId, postId, taskId, cmd))
      .rejects.toMatchObject({ status: 503 });
    expect(posts.releaseEditorialStory).toHaveBeenCalledTimes(1);
    expect(postService.startWorkflow).not.toHaveBeenCalled();
  });
});

describe('028B.4C explicit live queue (mock ports, no external calls)',()=>{
  const org='org-modes',target='max:-73052031470103',integration='mock-review-image-automatic';
  const scheduled={command_id:commandId,action:'queue' as const,publish_at:'2099-01-01T05:00:00.000Z'};
  const bytes=Buffer.from('ffd8ffd9','hex'); // decoded-JPEG proof is the existing preview port's responsibility
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const file='22222222-2222-4222-8222-222222222222',plan='33333333-3333-4333-8333-333333333333';
  const binding={org_id:org,post_id:postId,task_id:taskId,is_test:true,integration_id:integration};
  const state={binding,text:{revision:1,sha256:'c'.repeat(64)},seq:'3',image_mode:'automatic',
    final_approved:true,rejected:false,text_status:'approved',image_compatible:true,image_intent:null,
    text_request_id:null,publishable:false,dispatch_authorized:false,image:{revision:1,sha256:'d'.repeat(64)}};
  const view={receipt:{binding,text:state.text,image_mode:'automatic'},review_acknowledged:true,
    review:{status:'idle',last_confirmed_state:state}};
  const ctx={scope:{org_id:org,is_test:true,profile_ref:'review-ci@v77',integration_id:integration,
    campaign_id:'mock-image-crossdb',image_mode:'automatic',channel_id:'42'},state,status:'idle',
    publishable:false,dispatch_authorized:false,media:{file_id:file,revision:1,sha256,mime:'image/jpeg',
      size_bytes:bytes.length,asset:{plan_id:plan,sha256,mime:'image/jpeg',size_bytes:bytes.length}}};
  const verified={bytes,file_id:file,revision:1,sha256,mime:'image/jpeg',compatible:true,
    remote_current_verified:true,publishable:false,dispatch_authorized:false};
  const result={created:true,source_post_id:postId,publication_post_id:publicationId,mode:'queue',
    publish_at:scheduled.publish_at,provider_version:'v1',status:'recorded',publishable:false,dispatch_authorized:false};
  const posts={readEditorialHuman:vi.fn(),readEditorialRelease:vi.fn(),readLiveImageContext:vi.fn(),
    releaseLiveEditorialStory:vi.fn(),releaseEditorialStory:vi.fn()};
  const postService={previewEditorialStorySlot:vi.fn(),startWorkflow:vi.fn()};
  const roles={getEffectivePermissions:vi.fn()},audit={record:vi.fn()},images={preview:vi.fn()};
  let service:EditorialReleaseService;
  beforeEach(()=>{
    vi.resetAllMocks();
    for(const [k,v] of Object.entries({EDITORIAL_TEST_SESSION_ENABLED:'true',EDITORIAL_TEST_ORG_ID:org,
      EDITORIAL_TEST_MAX_TARGET:target,EDITORIAL_TEST_RELEASE_ENABLED:'true',
      EDITORIAL_TEST_LIVE_IMAGE_RELEASE_ENABLED:'true',EDITORIAL_TEST_LIVE_IMAGE_RELEASE_WORKER_ENABLED:'1',
      EDITORIAL_TEST_LIVE_IMAGE_IMPORT_ENABLED:'true',EDITORIAL_TEST_LIVE_IMAGE_REVIEW_ENABLED:'true',
      EDITORIAL_TEST_LIVE_IMAGE_PREVIEW_ENABLED:'true',EDITORIAL_TEST_LIVE_IMAGE_HUMAN_ENABLED:'true',
      EDITORIAL_TEST_MOCK_IMAGE_IMPORT_ENABLED:'false'}))vi.stubEnv(k,v);
    posts.readEditorialHuman.mockResolvedValue(view);posts.readEditorialRelease.mockResolvedValue(null);
    posts.readLiveImageContext.mockResolvedValue(ctx);posts.releaseLiveEditorialStory.mockResolvedValue(result);
    images.preview.mockResolvedValue(verified);roles.getEffectivePermissions.mockResolvedValue({permissions:['posts:manage']});
    postService.previewEditorialStorySlot.mockResolvedValue({publishAt:scheduled.publish_at});
    service=new EditorialReleaseService(posts as never,postService as never,roles as never,audit as never,
      {enabled:true,testOrgId:org,targetInternalId:target},images as never);
  });
  afterEach(()=>vi.unstubAllEnvs());
  it('only queue, exact state/pin/private bytes, one native schedule after commit',async()=>{
    expect(await service.release(org,userId,postId,taskId,scheduled)).toMatchObject({created:true,mode:'queue',max_delivery_confirmed:false});
    expect(images.preview).toHaveBeenCalledExactlyOnceWith(org,postId,taskId,target,state);
    expect(posts.releaseLiveEditorialStory).toHaveBeenCalledExactlyOnceWith(org,postId,taskId,target,userId,scheduled,
      state,{plan_id:plan,native_file_id:file,asset_sha256:sha256},bytes);
    expect(postService.startWorkflow).toHaveBeenCalledExactlyOnceWith('max',publicationId,org,'QUEUE','v1');
    expect(posts.releaseEditorialStory).not.toHaveBeenCalled();
  });
  it('preview offers only queue and never returns private bytes or schedules',async()=>{
    expect(await service.preview(org,userId,postId,taskId)).toEqual({ready:true,status:'available',
      next_slot:{publishAt:scheduled.publish_at},allowed_actions:['queue']});
    expect(posts.releaseLiveEditorialStory).not.toHaveBeenCalled();expect(postService.startWorkflow).not.toHaveBeenCalled();
  });
  it.each(['disabled','mock','publish_now','not_final','wrong_profile','revoked','changed','wrong_bytes','lost_membership'] as const)(
    'fails closed before SQL: %s',async scenario=>{
      if(scenario==='disabled')vi.stubEnv('EDITORIAL_TEST_LIVE_IMAGE_RELEASE_ENABLED','false');
      if(scenario==='mock')vi.stubEnv('EDITORIAL_TEST_MOCK_IMAGE_IMPORT_ENABLED','true');
      if(scenario==='not_final')posts.readEditorialHuman.mockResolvedValue({...view,review:{...view.review,last_confirmed_state:{...state,final_approved:false}}});
      if(scenario==='wrong_profile')posts.readLiveImageContext.mockResolvedValue({...ctx,scope:{...ctx.scope,profile_ref:'other'}});
      if(scenario==='revoked')images.preview.mockRejectedValue(new Error('signed denial'));
      if(scenario==='changed')posts.readLiveImageContext.mockResolvedValueOnce(ctx).mockResolvedValueOnce({...ctx,state:{...state,seq:'4'}});
      if(scenario==='wrong_bytes')images.preview.mockResolvedValue({...verified,bytes:Buffer.from('00000000','hex')});
      if(scenario==='lost_membership')roles.getEffectivePermissions.mockResolvedValueOnce({permissions:['posts:update']}).mockResolvedValueOnce(null);
      await expect(service.release(org,userId,postId,taskId,scenario==='publish_now'?cmd:scheduled)).rejects.toBeDefined();
      expect(posts.releaseLiveEditorialStory).not.toHaveBeenCalled();expect(posts.releaseEditorialStory).not.toHaveBeenCalled();
      expect(postService.startWorkflow).not.toHaveBeenCalled();
    });
  it('unknown native commit is not replayed; no fallback or scheduler request',async()=>{
    posts.releaseLiveEditorialStory.mockRejectedValueOnce(Error('lost COMMIT response'));
    await expect(service.release(org,userId,postId,taskId,scheduled)).rejects.toMatchObject({status:503});
    expect(posts.releaseLiveEditorialStory).toHaveBeenCalledTimes(1);expect(posts.releaseEditorialStory).not.toHaveBeenCalled();
    expect(postService.startWorkflow).not.toHaveBeenCalled();
  });
  it.each([{publish_at:'2099-01-02T05:00:00.000Z'},{publication_post_id:postId},{dispatch_authorized:true}])(
    'rejects inconsistent acknowledged release result: %j',async delta=>{
      posts.releaseLiveEditorialStory.mockResolvedValueOnce({...result,...delta});
      await expect(service.release(org,userId,postId,taskId,scheduled)).rejects.toMatchObject({status:503});
      expect(posts.releaseLiveEditorialStory).toHaveBeenCalledTimes(1);expect(postService.startWorkflow).not.toHaveBeenCalled();
    });
  it('native replay never requests a second scheduler event',async()=>{
    posts.releaseLiveEditorialStory.mockResolvedValueOnce({...result,created:false,status:'already_recorded'});
    expect(await service.release(org,userId,postId,taskId,scheduled)).toMatchObject({created:false,status:'already_recorded'});
    expect(postService.startWorkflow).not.toHaveBeenCalled();
  });
});
