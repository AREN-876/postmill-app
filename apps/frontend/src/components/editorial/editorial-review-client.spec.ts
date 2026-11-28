import { describe, expect, it, vi } from 'vitest';
import { editorialReviewClient } from './editorial-review-client';

const postId = 'a'.repeat(32);
const jpeg = new Uint8Array([255, 216, 255, 217]);
const response = (body: Uint8Array, headers: Record<string,string> = {}) =>
  new Response(new Uint8Array(body).buffer, { headers: { 'content-type': 'image/jpeg', ...headers } });

describe('session live JPEG preview client', () => {
  it('uses the scoped POST, expected sequence and no-store request', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(jpeg, { 'content-length': '4' }));
    const blob = await editorialReviewClient(fetcher).previewLiveImage(postId, '42', '8');
    expect(blob.type).toBe('image/jpeg');
    expect(blob.size).toBe(4);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/editorial/review/' + postId + '/42/live-image/preview',
      expect.objectContaining({ method: 'POST', cache: 'no-store', redirect: 'error',
        body: '{"expected_seq":"8"}', headers: { Accept: 'image/jpeg' } }));
  });
  it('rejects bad sequence before fetch', async () => {
    const fetcher = vi.fn();
    await expect(editorialReviewClient(fetcher).previewLiveImage(postId, '42', '9223372036854775808')).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects failure, non-JPEG, wrong size and over-limit response without retry', async () => {
    for (const res of [
      new Response(null, { status: 409 }),
      response(jpeg, { 'content-type': 'text/html' }),
      response(jpeg, { 'content-length': '8' }),
      response(jpeg, { 'content-length': '8388609' }),
      response(new Uint8Array(8 * 1024 * 1024 + 1)),
    ]) {
      const fetcher = vi.fn().mockResolvedValue(res);
      await expect(editorialReviewClient(fetcher).previewLiveImage(postId, '42', '8')).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
});


describe('separate live image mutation routes', () => {
  it('sends exact sequence only and refuses unknown result without fallback', async () => {
    const fetcher=vi.fn().mockResolvedValue(new Response(null,{status:503}));
    await expect(editorialReviewClient(fetcher).importImage(postId,'42','8',true)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/editorial/review/'+postId+'/42/live-image/import',
      expect.objectContaining({method:'POST',redirect:'error',body:'{"expected_seq":"8"}'}));
  });
  it('routes live approval through native-specific endpoint without a client pin', async () => {
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status:'queued/unconfirmed',event_id:'22222222-2222-4222-8222-222222222222',
      publishable:false,dispatch_authorized:false,
    })));
    const command={command_id:'11111111-1111-4111-8111-111111111111',expected_seq:'8',action:'approve_final' as const,feedback:''};
    await editorialReviewClient(fetcher).queue(postId,'42',command,true);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/editorial/review/'+postId+'/42/live-image/decisions',
      expect.objectContaining({method:'POST',redirect:'error',body:JSON.stringify(command)}));
  });
});
