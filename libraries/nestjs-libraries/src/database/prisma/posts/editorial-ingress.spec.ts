import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { prepareEditorialDraft } from './editorial-ingress';
import { STORYGO_DIVIDER } from '@postmill-ai/provider-kernel/domains/max-story';

const secret = 'edx_v1_' + 'a'.repeat(64);
const auth = 'Bearer ' + secret;
const now = Date.parse('2026-11-19T00:00:00.000Z');
const scope = {
  org_id: 'org-a', integration_id: 'max-a', campaign_id: 'campaign-a',
  channel_id: '42', profile_ref: 'life-stories-terra-test@v1',
  is_test: true, image_mode: 'after_text_approval',
};
const config = {
  ...scope, token_sha256: createHash('sha256').update(secret).digest('hex'),
  expires_at: '2026-11-20T00:00:00.000Z',
};
// Independent PG17 fixture checks this exact hash from jsonb::text.
const digest = '718025e8f4c2b602bfaf1605f6c9183ee8b5edb60382b6cb929d3ca518f1e840';
const content = {
  title: 'Заголовок',
  parts: ['Первый «текст» 😀\nСтрока "цитата" и \\ путь', 'Второй\tтекст', 'Третий\nфинал'],
};
const body = {
  schema_version: 1, task_id: '9223372036854775807', ...scope,
  text: { revision: 1, sha256: digest }, content,
};
const prepare = (input: unknown = body, credential: unknown = auth, cfg: unknown = config) =>
  prepareEditorialDraft(credential, cfg, input, now);

describe('Editorial Exchange 06B-1 ingress', () => {
  it('maps the exact initial artifact to native MAX story storage, with no secret in result', () => {
    const draft = prepare();
    expect(draft.scope).toEqual(scope);
    expect(draft.task_id).toBe(body.task_id);
    expect(draft.content).toEqual(content);
    expect(draft.text).toEqual(body.text);
    expect(draft.firstPart).toBe(content.title + '\n\n' + content.parts[0]);
    expect(draft.continuationText).toBe(content.parts[1] + '\n' + STORYGO_DIVIDER + '\n' + content.parts[2]);
    expect(JSON.stringify(draft)).not.toContain(config.token_sha256);
    expect(JSON.stringify(draft)).not.toContain(secret);
    expect(prepare({ ...body, content: { parts: [...content.parts], title: content.title } })).toEqual(draft);
    expect(draft.content.parts).not.toBe(content.parts);
  });
  it.each([null, '', 'Bearer pm_live_test', 'pos_token', secret, auth + ' ', 'Bearer edx_v1_' + 'b'.repeat(64), [auth]])(
    'rejects missing, wrong, generic or ambiguous credentials', (credential) => {
      expect(() => prepare(body, credential)).toThrow('unauthorized');
    },
  );
  it.each([
    null, {}, { ...config, token_sha256: '0'.repeat(64) },
    { ...config, expires_at: '2026-11-19T00:00:00.000Z' },
    { ...config, expires_at: '2026-02-30T00:00:00.000Z' },
    { ...config, is_test: false }, { ...config, integration_id: 'fixture:a' },
    { ...config, extra: true }, { ...config, campaign_id: '*' },
  ])('fails closed for missing, expired or invalid configured scope', (cfg) => {
    expect(() => prepare(body, auth, cfg)).toThrow('unauthorized');
  });
  it.each([
    { org_id: 'org-b' }, { integration_id: 'max-b' }, { campaign_id: 'campaign-b' },
    { channel_id: '43' }, { profile_ref: 'life-stories-terra-test@v2' },
    { is_test: false }, { image_mode: 'disabled' },
  ])('rejects a request outside the credential scope', (patch) => {
    expect(() => prepare({ ...body, ...patch })).toThrow('scope_mismatch');
  });
  it.each([
    { schema_version: 2 }, { task_id: 1 }, { task_id: '01' }, { task_id: '0' },
    { task_id: '9223372036854775808' }, { task_id: '-1' },
    { state: 'QUEUE' }, { publishDate: '2026-11-19' }, { image: [] },
    { text: { revision: 2, sha256: digest } },
    { text: { revision: 1, sha256: digest.toUpperCase() } },
  ])('rejects unsupported identity, version or fields', (patch) => {
    expect(() => prepare({ ...body, ...patch })).toThrow('invalid_request');
  });
  it.each([
    { title: ' Заголовок' }, { title: 'строка\nстрока' }, { title: 'a'.repeat(161) },
    { parts: ['one', 'two'] }, { parts: ['one', '', 'three'] },
    { parts: ['one', 'two', 'three', 'four'] }, { parts: ['one', null, 'three'] },
    { parts: ['one', 'two\r\ntext', 'three'] }, { parts: ['one', '\ud800', 'three'] },
    { parts: ['one', '\u0000', 'three'] }, { parts: ['one', '<script>x</script>', 'three'] },
    { parts: ['one', '&lt;script&gt;', 'three'] },
    { parts: ['one', STORYGO_DIVIDER, 'three'] }, { parts: ['one', '---', 'three'] },
    { parts: ['a'.repeat(4000), 'two', 'three'] },
    { parts: ['one', '😀'.repeat(2001), 'three'] },
  ])('rejects ambiguous, malformed or oversized story without editing it', (patch) => {
    expect(() => prepare({ ...body, content: { ...content, ...patch } })).toThrow('invalid_request');
  });
  it('rejects altered text or a forged digest even with a valid credential', () => {
    expect(() => prepare({ ...body, content: { ...content, title: 'Другой' } })).toThrow('digest_mismatch');
    expect(() => prepare({ ...body, text: { revision: 1, sha256: '0'.repeat(64) } })).toThrow('digest_mismatch');
  });
});
