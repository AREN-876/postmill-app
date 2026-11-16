import { stripHtmlValidation } from '@postmill-ai/helpers/utils/strip.html.validation';
import { maxStoryDraft } from '@postmill-ai/provider-kernel/domains/max-story';

// TipTap sends rich HTML; StoryGo accepts plain text only. This same
// conversion is used by preflight and persistence, so their limits agree.
const TIPTAP_HTML = /<\/?(?:p|span|strong|br|a|h[1-6]|ul|li)(?:\s|>)/i;

export function normalizeMaxStoryEditorText(value: string): string {
  if (!TIPTAP_HTML.test(value)) return value;
  // Existing normal-mode stripping retains paragraph boundaries but removes
  // <br> tags; preserve those line breaks before sanitizing.
  return stripHtmlValidation('normal', value.replace(/<br\s*\/?>/gi, '\n'), false, true);
}

export function preparePostmillMaxStory(
  firstOrFull: unknown,
  continuation: unknown = ''
): ReturnType<typeof maxStoryDraft> {
  return maxStoryDraft(
    typeof firstOrFull === 'string'
      ? normalizeMaxStoryEditorText(firstOrFull)
      : firstOrFull,
    continuation,
  );
}
