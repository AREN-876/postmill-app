import { beforeEach, describe, expect, it } from 'vitest';
import { ProviderKernel, SocialCapability } from '@postmill-ai/provider-kernel';
import { providerModules } from '@postmill-ai/backend/providers.generated';
import { bot, chat, chatId, member, post, sent, token } from './fixtures';
import { installTransport, response, wire } from './transport';

// Kernel -> bridge -> MAX -> SocialAbstract -> synthetic wire. No DB or MAX API.
describe('MAX registered kernel integration', () => {
  beforeEach(installTransport);
  it.each(['write', 'post_edit_delete_message'])('resolves the registered v1 module and posts a fixture with %s permission', async permission => {
    const kernel = new ProviderKernel();
    const maxModule = providerModules.find(
      (m) => m.manifest.domain === 'social' && m.manifest.providerId === 'max',
    )!;
    expect(maxModule).toBeDefined();
    kernel.register(maxModule);
    const context: any = {
      credentials: { clientId: token },
      telemetry: { recordCall() {} },
    };
    const capability = kernel
      .resolveForWrite<unknown, SocialCapability>('social', 'max', 'v1')
      .create(context);
    expect(wire).not.toHaveBeenCalled();
    wire.mockImplementation(async (url: string, init: RequestInit) => {
      expect(init.headers).toMatchObject({ Authorization: token });
      if (url.endsWith('/me') && url.includes('/members/'))
        return response({ ...member, permissions: [permission] });
      if (url.endsWith('/me')) return response(bot);
      if (url.endsWith(`/chats/${chatId}`)) return response(chat);
      if (url.endsWith(`/messages?chat_id=${chatId}&disable_link_preview=true`)) return response(sent);
      throw Error('Unexpected route in synthetic transport');
    });
    const auth = await capability.authenticate({
      code: chatId,
      codeVerifier: '',
    });
    expect(auth).toMatchObject({ id: `max:${chatId}`, accessToken: token });
    expect(wire.mock.calls.every(([, init]) => init.method === 'GET')).toBe(
      true,
    );
    const result = await capability.post(chatId, token, [post], {});
    expect(result[0]).toMatchObject({
      id: post.id,
      postId: sent.message.body.mid,
      status: 'completed',
    });
    expect(
      wire.mock.calls.filter(([, init]) => init.method === 'POST'),
    ).toHaveLength(1);
  });
});
