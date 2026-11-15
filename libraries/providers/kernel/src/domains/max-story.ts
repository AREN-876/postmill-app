/**
 * Shared canonical Postmill/StoryGo text contract. The first part is Post.content;
 * subsequent parts remain in persisted MAX settings (not independent posts).
 */
export const STORYGO_DIVIDER = '────────────────────────';
const DIVIDER_LINE = /^[─━═—–-]{3,}$/u;

export class MaxStoryValidationError extends Error {}

export function maxStoryParts(first: unknown, continuation: unknown) {
  if (typeof first !== 'string' || typeof continuation !== 'string') {
    throw new MaxStoryValidationError('Story requires a first part and continuation text.');
  }
  // Preserve every approved byte: CRLF normalization would mutate the snapshot.
  const source = [first, continuation];
  if (source.some((s) => s.includes('\r') || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(s))) {
    throw new MaxStoryValidationError('Story contains unsupported control characters or CRLF.');
  }
  if (first.split('\n').some((line) => line === STORYGO_DIVIDER || DIVIDER_LINE.test(line.trim()))) {
    throw new MaxStoryValidationError('The public first part must not contain continuation dividers.');
  }
  const lines = continuation.split('\n');
  const parts: string[] = [first];
  let section: string[] = [];
  for (const line of lines) {
    if (line === STORYGO_DIVIDER) {
      parts.push(section.join('\n'));
      section = [];
    } else {
      if (DIVIDER_LINE.test(line.trim())) {
        throw new MaxStoryValidationError('Use the exact StoryGo divider on a separate line.');
      }
      section.push(line);
    }
  }
  parts.push(section.join('\n'));
  if (parts.length < 2 || parts.length > 1000 || parts.some((p) => !p.trim())) {
    throw new MaxStoryValidationError('Story must contain 2–1000 nonempty parts.');
  }
  if (parts.some((p) => p.length > 4000)) {
    throw new MaxStoryValidationError('Each story part must contain at most 4000 UTF-16 units.');
  }
  const title = first.split('\n').find((line) => line.trim())?.trim() ?? '';
  if (!title || title.length > 160 || title.includes('\t')) {
    throw new MaxStoryValidationError('The first nonempty title line must contain 1–160 characters.');
  }
  // Recheck total JSON boundary with generous room for metadata and UTF-8 expansion.
  if (new TextEncoder().encode(JSON.stringify(parts)).length > 7 * 1024 * 1024) {
    throw new MaxStoryValidationError('Story exceeds the Gateway JSON size limit.');
  }
  return { title, parts };
}
