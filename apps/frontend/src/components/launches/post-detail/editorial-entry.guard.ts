/**
 * Presentation-only feature flag for the dormant human editorial panel.
 *
 * This is not authentication: the Nest session/CSRF/RBAC and exact test
 * org/MAX-target allowlist remain mandatory. Default is disabled, including
 * when either build-time flag is absent. Match immutable target identity,
 * NEVER a channel's editable display name.
 */
type PostCandidate = {
  id?: string | null;
  state?: string | null;
  editorialTaskId?: string | null;
} | null | undefined;

type ChannelCandidate = {
  providerIdentifier?: string | null;
  internalId?: string | null;
} | null | undefined;

const POST_ID = /^[0-9a-f]{32}$/;
const TASK_ID = /^[1-9][0-9]{0,18}$/;

export function canShowEditorialReviewInPostDetail(
  post: PostCandidate,
  channel: ChannelCandidate,
  enabled: string | undefined,
  exactTestTargetId: string | undefined,
): post is NonNullable<PostCandidate> & { id: string; editorialTaskId: string } {
  return enabled === 'true' &&
    typeof exactTestTargetId === 'string' &&
    /^max:[-0-9]{1,100}$/.test(exactTestTargetId) &&
    post?.state === 'DRAFT' &&
    typeof post.id === 'string' && POST_ID.test(post.id) &&
    typeof post.editorialTaskId === 'string' &&
    TASK_ID.test(post.editorialTaskId) &&
    (post.editorialTaskId.length < 19 ||
      post.editorialTaskId <= '9223372036854775807') &&
    channel?.providerIdentifier === 'max' &&
    channel.internalId === exactTestTargetId;
}
