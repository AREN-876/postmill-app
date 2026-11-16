import {
  AnalyticsData,
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
import { createHash } from 'node:crypto';
import { metadata } from './metadata';
import { MaxSettingsDto } from '@postmill-ai/provider-kernel/domains/social-dtos/max.dto';
import { maxStoryParts } from '@postmill-ai/provider-kernel/domains/max-story';

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

/** MAX Bot API: text, one normal media attachment, and StoryGo stories. */
export class MaxProvider extends SocialAbstract implements SocialProvider {
  identifier = 'max';
  name = 'MAX';
  dto = MaxSettingsDto;
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
    attachments?: Array<{ type: 'image' | 'video'; payload: { token: string } }>,
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
          ...(text === undefined ? {} : { body: JSON.stringify({ text, ...(attachments?.length ? { attachments } : {}) }) }),
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
    return posts.some((media) => media.length > 1)
      ? 'MAX supports a maximum of one image or video per normal post.'
      : true;
  }

  /**
   * Read cumulative channel-post views by MAX MID. These are post metrics,
   * distinct from channel-wide analytics and StoryGo reader completions.
   * No write operation, new scheduler or raw response persistence.
   */
  async postAnalytics(
    id: string,
    accessToken: string,
    postId: string,
    _daysBack: number,
  ): Promise<AnalyticsData[]> {
    const channelId = this.chatId(id.startsWith('max:') ? id.slice(4) : id);
    const token = this.token(accessToken);
    // MID is a single opaque identifier, never a list or arbitrary URL.
    // Live MAX ids include a dot (e.g. mid.ffff...), so do not use the
    // more restrictive path-parameter regexp from GET /messages/{id}.
    if (typeof postId !== 'string' || !/^[A-Za-z0-9_.-]{1,200}$/.test(postId))
      return [];

    const result = await this.request(
      `/messages?message_ids=${encodeURIComponent(postId)}`,
      token,
    );
    if (!Array.isArray(result.messages)) this.fail(errors.response);

    const matches = result.messages.filter(
      (message: any) => message?.body?.mid === postId,
    );
    if (matches.length !== 1) return [];
    const message = matches[0];
    // One bot may administer several channels. Never attribute a MID
    // from a different channel to this Postmill integration.
    const recipientId =
      typeof message?.recipient?.chat_id === 'string'
        ? message.recipient.chat_id
        : Number.isSafeInteger(message?.recipient?.chat_id)
          ? String(message.recipient.chat_id)
          : '';
    if (recipientId !== channelId) return [];

    // stat may legitimately be absent. Missing is NOT zero.
    const views = message?.stat?.views;
    if (!Number.isSafeInteger(views) || views < 0) return [];

    return [
      {
        label: 'Views',
        data: [{ total: String(views), date: new Date().toISOString().slice(0, 10) }],
      },
    ];
  }

  /**
   * StoryGo transport is opt-in and bound to an operator-controlled HTTPS
   * origin, service credential and explicit channel allowlist. It NEVER
   * receives the MAX bot token and it never follows redirects.
   */
  private gatewayConfig(chatId: string) {
    const raw = process.env.STORYGO_GATEWAY_BASE_URL;
    const secret = process.env.STORYGO_GATEWAY_SERVICE_KEY;
    const allowed = (process.env.STORYGO_GATEWAY_ALLOWED_CHANNELS || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    if (process.env.STORYGO_GATEWAY_ENABLED !== '1' ||
        !raw || !secret || secret.length < 32 ||
        !allowed.includes(chatId)) {
      this.fail('StoryGo Gateway is disabled or this MAX channel is not allowed.');
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      this.fail('StoryGo Gateway HTTPS origin is invalid.');
    }
    if (url.protocol !== 'https:' || !!url.username || !!url.password ||
        url.pathname !== '/' || !!url.search || !!url.hash) {
      this.fail('StoryGo Gateway requires an HTTPS origin without path or credentials.');
    }
    return { origin: url.origin, secret };
  }

  private async gatewayRequest(
    origin: string, secret: string, method: 'POST' | 'GET',
    path: string, operationId: string, body?: object,
  ): Promise<any> {
    try {
      const response = await this.fetch(
        origin + path,
        {
          method,
          redirect: 'error',
          retryPolicy: 'none',
          headers: {
            Authorization: 'Bearer ' + secret,
            ...(method === 'POST' ? {
              'Content-Type': 'application/json',
              'Idempotency-Key': operationId,
            } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
        'storygo-gateway',
      );
      // A gateway's 202 is explicitly NOT a published post.
      if (![200, 202].includes(response.status)) {
        this.fail('StoryGo Gateway returned an unexpected status.');
      }
      const data = await response.json();
      if (!data || typeof data !== 'object') this.fail('Invalid StoryGo Gateway receipt.');
      return data;
    } catch {
      // MAX token, gateway token and upstream error bodies must never escape
      // into Inngest state, Sentry, journal errors or user-facing notifications.
      this.fail('StoryGo Gateway response unavailable; delivery requires operator review.');
    }
  }

  private verifiedGatewayReceipt(
    receipt: any, operationId: string, chatId: string,
  ): string | null {
    if (receipt.operation_id !== operationId ||
        receipt.channel_id !== chatId ||
        !['PENDING', 'SENDING', 'PUBLISHED', 'FAILED', 'NEEDS_REVIEW'].includes(receipt.state)) {
      this.fail('StoryGo Gateway receipt does not match the requested operation or channel.');
    }
    if (receipt.state === 'PUBLISHED') {
      if (typeof receipt.message_id !== 'string' ||
          !/^[A-Za-z0-9_.-]{1,200}$/.test(receipt.message_id)) {
        this.fail('StoryGo Gateway did not confirm a valid MAX MID.');
      }
      return receipt.message_id;
    }
    return null;
  }

  /** Read-only crash recovery: never POST, and never synthesize a MID. */
  async reconcileStoryGoOperation(id: string, operationId: string): Promise<string | null> {
    const chatId = this.chatId(id.startsWith('max:') ? id.slice(4) : id);
    if (typeof operationId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operationId)) {
      this.fail('Invalid StoryGo Gateway operation identifier.');
    }
    const { origin, secret } = this.gatewayConfig(chatId);
    const receipt = await this.gatewayRequest(
      origin, secret, 'GET', '/gateway/v1/publications/' + operationId, operationId,
    );
    return this.verifiedGatewayReceipt(receipt, operationId, chatId);
  }

  /**
   * Upload exactly one verified, organization-owned PNG/JPEG from ephemeral
   * server memory. A source URL or filesystem path is NEVER accepted here.
   * The response binds upload_id to the channel/principal and the SHA.
   */
  private async uploadStoryPhoto(
    origin: string, secret: string, chatId: string,
    image: { base64: string; mimeType: string; sha256: string },
  ) {
    if (!image || typeof image.base64 !== 'string' ||
        !['image/jpeg', 'image/png'].includes(image.mimeType) ||
        typeof image.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(image.sha256)) {
      this.fail('Invalid StoryGo photo snapshot.');
    }
    const bytes = Buffer.from(image.base64, 'base64');
    if (!bytes.length || bytes.length > 8 * 1024 * 1024 ||
        bytes.toString('base64') !== image.base64 ||
        createHash('sha256').update(bytes).digest('hex') !== image.sha256) {
      this.fail('StoryGo photo bytes do not match the approved snapshot.');
    }
    const form = new FormData();
    form.set('channel_id', chatId);
    form.set('file', new Blob([new Uint8Array(bytes)], {
      type: image.mimeType,
    }), image.mimeType === 'image/png' ? 'story.png' : 'story.jpg');
    try {
      const response = await this.fetch(origin + '/gateway/v1/media', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + secret },
        body: form,
        retryPolicy: 'none',
        redirect: 'error',
      }, 'storygo-gateway');
      if (response.status !== 201) this.fail('Unexpected StoryGo photo upload response.');
      const data = await response.json();
      if (!data || typeof data.upload_id !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(data.upload_id) ||
          data.sha256 !== image.sha256 || data.mime_type !== image.mimeType ||
          data.bytes !== bytes.length) {
        this.fail('StoryGo photo receipt does not match the approved image.');
      }
      return data.upload_id as string;
    } catch {
      // Gateway may have stored bytes; this is NOT a publication receipt.
      // Do not resend on an uncertain response in the same occurrence.
      this.fail('StoryGo photo upload unresolved; operator review required.');
    }
  }

  private async publishStory(
    chatId: string,
    post: PostDetails,
  ): Promise<PostResponse[]> {
    const gateway = (post.settings as any)?.__gateway;
    const operationId = gateway?.operationId;
    if (typeof operationId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operationId) ||
        typeof gateway?.externalPostId !== 'string' ||
        gateway.externalPostId !== post.id ||
        !/^max_[a-f0-9]{64}$/.test(gateway?.revision || '')) {
      this.fail('StoryGo Gateway requires a stable confirmed MAX occurrence.');
    }
    if (post.media?.length || post.poll || post.firstComment || post.settings?.firstComment) {
      this.fail('StoryGo Gateway text-only phase does not allow media, polls or comments.');
    }
    let story: ReturnType<typeof maxStoryParts>;
    try {
      story = maxStoryParts(post.message, (post.settings as any).continuationText);
    } catch {
      this.fail('StoryGo Gateway rejected malformed story parts.');
    }
    const { origin, secret } = this.gatewayConfig(chatId);
    const path = '/gateway/v1/publications';
    // Upload is performed immediately before the single publication POST.
    // upload_id expires in one hour and must never be persisted in Postmill
    // settings days before scheduling.
    const uploadId = gateway.image
      ? await this.uploadStoryPhoto(origin, secret, chatId, gateway.image)
      : undefined;
    const body = {
      type: 'story',
      channel_id: chatId,
      external_post_id: post.id,
      operation_id: operationId,
      revision: gateway.revision,
      title: story.title,
      parts: story.parts,
      ...(uploadId ? { upload_id: uploadId } : {}),
    };
    let receipt: any;
    try {
      // One and only one remote POST for a claimed occurrence. Never retry it.
      receipt = await this.gatewayRequest(origin, secret, 'POST', path, operationId, body);
    } catch {
      // POST outcome may be unknown. GET is read-only and safe to reconcile.
      receipt = null;
    }
    if (receipt) {
      const mid = this.verifiedGatewayReceipt(receipt, operationId, chatId);
      if (mid) return [{ id: post.id, postId: mid, releaseURL: '', status: 'completed' }];
      if (receipt.state === 'FAILED' || receipt.state === 'NEEDS_REVIEW') {
        this.fail('StoryGo Gateway has not confirmed delivery; operator review required.');
      }
    }
    // A competing request can leave PENDING/SENDING. Never interpret 202 as
    // success and never issue a second POST, even after a transport timeout.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      let lookup: any;
      try {
        lookup = await this.gatewayRequest(
          origin, secret, 'GET', path + '/' + operationId, operationId,
        );
      } catch {
        continue;
      }
      const mid = this.verifiedGatewayReceipt(lookup, operationId, chatId);
      if (mid) return [{ id: post.id, postId: mid, releaseURL: '', status: 'completed' }];
      if (lookup.state === 'FAILED' || lookup.state === 'NEEDS_REVIEW') break;
    }
    this.fail('StoryGo Gateway delivery unconfirmed; operator review required.');
  }


  /**
   * MAX media is uploaded from a verified ephemeral library snapshot, never
   * by handing MAX a private Postmill URL or following an arbitrary upload URL.
   * Only an explicit, successful upload returns a token for POST /messages.
   */
  private async uploadNormalMedia(
    botToken: string,
    media: { base64: string; mimeType: string; mediaType: 'image' | 'video'; sha256: string },
  ): Promise<{ type: 'image' | 'video'; payload: { token: string } }> {
    const allowed = media?.mediaType === 'image'
      ? ['image/jpeg', 'image/png']
      : media?.mediaType === 'video' ? ['video/mp4', 'video/webm'] : [];
    const limit = media?.mediaType === 'video' ? 32 * 1024 * 1024 : 16 * 1024 * 1024;
    if (!media || !allowed.includes(media.mimeType) || typeof media.base64 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(media.sha256 || '')) {
      this.fail('Invalid MAX media snapshot.');
    }
    const bytes = Buffer.from(media.base64, 'base64');
    if (!bytes.length || bytes.length > limit || bytes.toString('base64') !== media.base64 ||
        createHash('sha256').update(bytes).digest('hex') !== media.sha256) {
      this.fail('MAX media bytes do not match the approved snapshot.');
    }
    // Current MAX documentation uses iu.oneme.ru for images and omub.okcdn.ru
    // for video (older docs also mention vu.okcdn.ru).
    const uploadHosts = media.mediaType === 'video'
      ? ['omub.okcdn.ru', 'vu.okcdn.ru'] : ['iu.oneme.ru'];
    try {
      const reservation = await this.fetch(API + '/uploads?type=' + media.mediaType, {
        method: 'POST', headers: { Authorization: botToken }, retryPolicy: 'none', redirect: 'error',
      }, 'max-api');
      if (reservation.status !== 200) throw Error('MAX upload reservation refused');
      const setup = await reservation.json() as any;
      if (typeof setup?.url !== 'string') throw Error('MAX upload URL missing');
      const uploadUrl = new URL(setup.url);
      // MAX specifies these fixed media upload hosts. No credentials or bot
      // token are ever forwarded to the signed upload URL.
      if (uploadUrl.protocol !== 'https:' || !uploadHosts.includes(uploadUrl.hostname) ||
          uploadUrl.username || uploadUrl.password || uploadUrl.port) {
        throw Error('MAX upload target is outside the official media host');
      }
      const form = new FormData();
      const extension = media.mimeType === 'image/jpeg' ? 'jpg'
        : media.mimeType === 'image/png' ? 'png'
        : media.mimeType === 'video/mp4' ? 'mp4' : 'webm';
      form.set('data', new Blob([new Uint8Array(bytes)], { type: media.mimeType }), 'post.' + extension);
      const uploaded = await this.fetch(uploadUrl.href, {
        method: 'POST', body: form, retryPolicy: 'none', redirect: 'error',
      }, 'max-upload');
      if (uploaded.status !== 200 && uploaded.status !== 201) {
        throw Error('MAX media upload refused');
      }
      // Images: {"photos":{"<photo_id>":{"token":"..."}}}.
      // Video: setup.token plus upload response may be XML <retval>1</retval>.
      const raw = await uploaded.text();
      let result: any;
      try { result = JSON.parse(raw); } catch { result = null; }
      if (media.mediaType === 'video') {
        const accepted = result
          ? result.retval === 1 || result.retval === true || result.retval === '1'
          : /<retval>\s*1\s*<\/retval>/.test(raw);
        if (!accepted) throw Error('MAX video upload was not acknowledged');
      } else if (!result || result.success === false || result.error || result.code) {
        throw Error('MAX image upload was not acknowledged');
      }
      const photoValues = result?.photos && typeof result.photos === 'object'
        ? Object.values(result.photos) : [];
      const photoToken = photoValues.length === 1 &&
        typeof (photoValues[0] as any)?.token === 'string'
        ? (photoValues[0] as any).token : null;
      const mediaToken = media.mediaType === 'video'
        ? setup.token || result?.token
        : photoToken || result?.token || setup.token || uploadUrl.searchParams.get('token');
      if (typeof mediaToken !== 'string' || !mediaToken.trim() || mediaToken.length > 2048) {
        throw Error('MAX did not return a media attachment token');
      }
      return { type: media.mediaType, payload: { token: mediaToken } };
    } catch {
      // Never expose signed URL query parameters or authorization headers.
      // The occurrence gate prevents another send after an ambiguous result.
      this.fail('MAX media upload was not confirmed; operator review required.');
    }
  }

  async post(
    id: string,
    accessToken: string,
    posts: PostDetails[],
  ): Promise<PostResponse[]> {
    const chatId = this.chatId(id.startsWith('max:') ? id.slice(4) : id);
    const token = this.token(accessToken);
    if (posts.length !== 1) this.fail('MAX requires exactly one post.');
    const post = posts[0];
    if (post.settings?.mode === 'story') {
      return this.publishStory(chatId, post);
    }
    if (post.settings?.mode && post.settings.mode !== 'normal') {
      this.fail('Unsupported MAX post type.');
    }
    if (
      typeof post.message !== 'string' ||
      (!post.message.trim() && !post.media?.length) ||
      post.message.length > this.maxLength()
    ) {
      this.fail('MAX text must contain 1–4000 characters.');
    }
    if (
      post.poll ||
      post.firstComment ||
      post.settings?.firstComment
    ) {
      this.fail('MAX does not support polls or first comments.');
    }
    if ((post.media?.length || 0) > 1 ||
        Boolean(post.media?.length) !== Boolean((post.settings as any)?.__maxMedia)) {
      this.fail('MAX supports one verified media attachment from the Postmill library.');
    }
    // Recheck rights before writing: permissions can change after connection.
    await this.channel(chatId, token);
    const attachments = post.media?.length
      ? [await this.uploadNormalMedia(token, (post.settings as any).__maxMedia)]
      : undefined;
    // MAX processes attachments asynchronously. Give it time before the
    // one non-retryable message POST (2s photo, 10s short video).
    if (attachments?.length) {
      await this.waitForMediaProcessing(attachments[0].type === 'video' ? 10_000 : 2_000);
    }
    const data = await this.request(
      `/messages?chat_id=${encodeURIComponent(chatId)}&disable_link_preview=true`,
      token,
      post.message,
      attachments,
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
