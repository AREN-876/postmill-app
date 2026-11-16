import { describe, expect, it } from 'vitest';
import { STORYGO_DIVIDER } from '@postmill-ai/provider-kernel/domains/max-story';
import { normalizeMaxStoryEditorText, preparePostmillMaxStory } from './max-story-input';

describe('Postmill MAX story editor normalization', () => {
  it('extracts the real short title and parts from TipTap paragraphs', () => {
    const html = [
      '<p><strong>Работал за начальника, числился инженером</strong></p>',
      '<p>— Денис, опять тебя ищут из третьего цеха.</p>',
      '<p>' + STORYGO_DIVIDER + '</p>',
      '<p>Второй эпизод</p>',
      '<p>' + STORYGO_DIVIDER + '</p>',
      '<p>Третий эпизод</p>',
    ].join('');
    const story = preparePostmillMaxStory(html);
    expect(story.title).toBe('Работал за начальника, числился инженером');
    expect(story.parts).toEqual([
      'Работал за начальника, числился инженером\n— Денис, опять тебя ищут из третьего цеха.',
      'Второй эпизод',
      'Третий эпизод',
    ]);
    expect(story.firstPart).not.toContain('<p>');
  });

  it('preserves the 4000 UTF-16 limit for each part, not whole HTML document', () => {
    const first = '<p>Заголовок</p><p>' + 'А'.repeat(3500) + '</p>';
    const input = first + '<p>' + STORYGO_DIVIDER + '</p><p>' + 'Б'.repeat(3500) + '</p>';
    expect(preparePostmillMaxStory(input).parts).toHaveLength(2);
    expect(() => preparePostmillMaxStory(
      '<p>Заголовок</p><p>' + STORYGO_DIVIDER + '</p><p>' + 'Б'.repeat(4001) + '</p>'
    )).toThrow('4000');
  });

  it('still accepts legacy separate continuations and plain text', () => {
    const first = 'Заголовок\nПервый абзац';
    const rest = 'Вторая часть\n' + STORYGO_DIVIDER + '\nТретья часть';
    const story = preparePostmillMaxStory('<p>Заголовок</p><p>Первый абзац</p>', rest);
    expect(story.parts).toEqual([first, 'Вторая часть', 'Третья часть']);
    expect(normalizeMaxStoryEditorText(first)).toBe(first);
  });

  it('preserves line breaks inserted as HTML br elements', () => {
    expect(normalizeMaxStoryEditorText('<p>Заголовок<br>Строка</p>')).toBe('Заголовок\nСтрока');
  });
});
