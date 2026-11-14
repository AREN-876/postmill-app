import {
  AuthTokenDetails,
  BadBody,
  ChannelSetupDescriptor,
  ClientInformation,
  makeOauthState,
  NotEnoughScopes,
  PostDetails,
  PostResponse,
  PROVIDER_CAPABILITIES,
  ProviderModule,
  SocialAbstract,
  SocialProvider,
  SocialProviderKernelAdapter,
  ValidityMedia,
} from '@postmill-ai/provider-kernel';
import { metadata } from './metadata';

const API = 'https://platform-api2.max.ru';
const errors = {
  auth: 'MAX rejected the bot token. Reconnect with a valid token.',
  forbidden: 'MAX denied access. Check channel membership and posting rights.',
  retry: 'MAX is temporarily unavailable or rate limited. Try again later.',
  request: 'MAX rejected the request. Check the channel and text.',
  transport: 'MAX request failed. Check connectivity and try again.',
  response: 'MAX returned an unexpected response.',
  delivery:
    'MAX delivery was not confirmed. Automatic resend is disabled; check the channel before retrying manually.',
};

/** Text-only MAX Bot API. No channel discovery, uploads or OAuth. */
export class MaxProvider extends SocialAbstract implements SocialProvider {
  identifier = 'max';
  name = 'MAX';
  editor = 'normal' as const;
  scopes: string[] = [];
  isBetweenSteps = false;
  isWeb3 = true; // reuse the interactive, nonce-bound token connection surface
  override setupDescriptor: ChannelSetupDescriptor = {
    authType: 'token',
    credentialFields: [
      {
        key: 'clientId',
        label: 'MAX Bot Token',
        secret: true,
        help: 'Obtain a separate test bot token from the MAX bot platform. Never use a production token for testing.',
      },
    ],
    portalUrl: 'https://dev.max.ru',
    portalLabel: 'MAX Bot Platform',
    setupSteps: [
      'Create a separate test bot and copy its token here.',
      'Add the bot as an administrator of a test channel with permission to post messages.',
      'Enter the exact chat_id from a bot_added event or an update for that channel. Channels cannot be enumerated.',
      'Connect performs read-only identity, channel and membership checks. It sends no message.',
    ],
  };

  maxLength() {
    return 4000;
  }

  async generateAuthUrl() {
    const state = makeOauthState();
    return { url: state, state, codeVerifier: makeOauthState() };
  }

  // Static bot tokens have no refresh endpoint. Fail closed instead of returning
  // blank credentials that could overwrite a valid connection.
  async refreshToken(): Promise<AuthTokenDetails> {
    throw new BadBody(this.identifier, '{}', '{}', errors.auth);
  }

  override handleErrors(_body: string, status: number) {
    return {
      type:
        status === 429 || status >= 500
          ? ('retry' as const)
          : ('bad-body' as const),
      value:
        status === 401
          ? errors.auth
          : status === 403
            ? errors.forbidden
            : status === 429 || status >= 500
              ? errors.retry
              : errors.request,
    };
  }

  private fail(message: string): never {
    throw new BadBody(this.identifier, '{}', '{}', message);
  }

  private chatId(value: string): string {
    // MAX ids are signed int64. Preserve the decimal string, never coerce an id
    // supplied by the user through Number (which can lose precision).
    if (
      typeof value !== 'string' ||
      !/^-?[1-9][0-9]{0,18}$/.test(value) ||
      BigInt(value) < BigInt('-9223372036854775808') ||
      BigInt(value) > BigInt('9223372036854775807')
    ) {
      this.fail('MAX requires a non-zero integer channel chat_id.');
    }
    return value;
  }

  private token(value?: string): string {
    if (typeof value !== 'string' || !value.trim() || /\s/.test(value))
      this.fail('MAX bot token is required.');
    return value;
  }

  private async request(
    path: string,
    token: string,
    text?: string,
  ): Promise<any> {
    try {
      const response = await this.fetch(
        `${API}${path}`,
        {
          method: text === undefined ? 'GET' : 'POST',
          // A message write has no idempotency/reconciliation contract. Keep
          // GET retries, but never resend POST (including via HTTP redirects).
          ...(text === undefined
            ? {}
            : { retryPolicy: 'none' as const, redirect: 'error' as const }),
          headers: { Authorization: token, 'Content-Type': 'application/json' },
          ...(text === undefined ? {} : { body: JSON.stringify({ text }) }),
        },
        'max-api',
      );
      const raw = await response.text();
      let data: any;
      try {
        // Node 24 exposes the original JSON numeric lexeme. Preserve int64
        // chat IDs before Number rounding; reject noncanonical/unsafe replies.
        data = JSON.parse(raw, ((key: string, value: any, context?: { source: string }) =>
          key === 'chat_id' && typeof value === 'number' && /^-?[0-9]+$/.test(context?.source ?? '')
            ? context!.source : value) as any);
      } catch { this.fail(errors.response); }

      if (
        !data ||
        typeof data !== 'object' ||
        data.error ||
        data.code ||
        data.success === false
      ) {
        this.fail(errors.response);
      }
      return data;
    } catch (error) {
      // SocialAbstract's errors retain upstream bodies. Never propagate those:
      // even a hostile API/transport echoing Authorization must not leak a token.
      const message =
        error instanceof Error && Object.values(errors).includes(error.message)
          ? error.message
          : errors.transport;
      this.fail(
        text !== undefined &&
          [errors.retry, errors.transport, errors.response].includes(message)
          ? errors.delivery
          : message,
      );
    }
  }

  private async channel(id: string, token: string) {
    const me = await this.request('/me', token);
    if (me.is_bot !== true || !Number.isSafeInteger(me.user_id))
      this.fail(errors.response);
    const chat = await this.request(`/chats/${id}`, token);
    // Reject unsafe numeric ids rather than connect a rounded channel id.
    const returnedId =
      typeof chat.chat_id === 'string'
        ? chat.chat_id
        : Number.isSafeInteger(chat.chat_id)
          ? String(chat.chat_id)
          : '';
    if (
      returnedId !== id ||
      chat.type !== 'channel' ||
      chat.status !== 'active' ||
      typeof chat.title !== 'string' ||
      !chat.title.trim()
    ) {
      this.fail('MAX requires an active channel matching chat_id.');
    }
    const member = await this.request(`/chats/${id}/members/me`, token);
    if (
      member.user_id !== me.user_id ||
      member.is_bot !== true ||
      !(
        member.is_owner === true ||
        (member.is_admin === true &&
          Array.isArray(member.permissions) &&
          (member.permissions.includes('write') ||
            member.permissions.includes('post_edit_delete_message')))
      )
    ) {
      this.fail(errors.forbidden);
    }
    return chat;
  }

  async authenticate(
    params: { code: string; codeVerifier: string },
    info?: ClientInformation,
  ) {
    const id = this.chatId(params.code);
    const token = this.token(info?.client_id || info?.token);
    const chat = await this.channel(id, token).catch((error) => {
      // Expected credential/permission rejection uses the handled channel-auth
      // path (409), not a Sentry application exception.
      if (
        error instanceof Error &&
        [errors.auth, errors.forbidden].includes(error.message)
      ) {
        throw new NotEnoughScopes(error.message);
      }
      throw error;
    });
    return {
      id: `max:${id}`,
      rootId: id,
      name: chat.title,
      accessToken: token,
      refreshToken: '',
      expiresIn: 0,
      picture: '',
      username: '',
    };
  }

  override async checkValidity(
    posts: ValidityMedia[][],
  ): Promise<string | true> {
    if (posts.length > 1)
      return 'MAX does not support threads or comments in this MVP.';
    return posts.some((media) => media.length)
      ? 'MAX supports text only in this MVP.'
      : true;
  }

  async post(
    id: string,
    accessToken: string,
    posts: PostDetails[],
  ): Promise<PostResponse[]> {
    const chatId = this.chatId(id.startsWith('max:') ? id.slice(4) : id);
    const token = this.token(accessToken);
    if (posts.length !== 1) this.fail('MAX requires exactly one text post.');
    const post = posts[0];
    if (
      typeof post.message !== 'string' ||
      !post.message.trim() ||
      post.message.length > this.maxLength()
    ) {
      this.fail('MAX text must contain 1–4000 characters.');
    }
    if (
      post.media?.length ||
      post.poll ||
      post.firstComment ||
      post.settings?.firstComment
    ) {
      this.fail(
        'MAX supports text only, without media, polls or first comments.',
      );
    }
    // Recheck rights before writing: permissions can change after connection.
    await this.channel(chatId, token);
    const data = await this.request(
      `/messages?chat_id=${encodeURIComponent(chatId)}&disable_link_preview=true`,
      token,
      post.message,
    );
    const message = data.message;
    if (typeof message?.body?.mid !== 'string' || !message.body.mid.trim())
      this.fail(errors.delivery);
    let releaseURL = '';
    if (typeof message.url === 'string') {
      try {
        const url = new URL(message.url);
        if (
          url.protocol === 'https:' &&
          url.hostname === 'max.ru' &&
          !url.username &&
          !url.password
        )
          releaseURL = url.href;
      } catch {
        /* A public URL is optional; never invent a link. */
      }
    }
    return [
      {
        id: post.id,
        postId: message.body.mid,
        releaseURL,
        status: 'completed',
      },
    ];
  }
}

export const maxSocialModule: ProviderModule = {
  metadata,
  manifest: {
    domain: 'social',
    providerId: 'max',
    version: 'v1',
    displayName: 'MAX',
    status: 'active',
    credentialFields: [],
    capabilities: PROVIDER_CAPABILITIES.max,
  },
  create: (ctx) => new SocialProviderKernelAdapter(new MaxProvider(), ctx),
};
