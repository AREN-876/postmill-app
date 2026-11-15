import { describe, expect, it } from 'vitest';
import { maxStoryParts, STORYGO_DIVIDER } from './max-story';

describe('MAX → StoryGo canonical story parts', () => {
  it('preserves exact paragraphs and recognizes only the full divider line', () => {
    const first = 'Заголовок\nПервый абзац\n\nВторой абзац';
    const rest = ['Продолжение\n', '\nФинал'].join('\n' + STORYGO_DIVIDER + '\n');
    expect(maxStoryParts(first, rest)).toEqual({
      title: 'Заголовок',
      parts: [first, 'Продолжение\n', '\nФинал'],
    });
  });

  it('rejects empty, ambiguous or malformed continuation documents', () => {
    for (const rest of [
      '', '   ', STORYGO_DIVIDER + '\nфинал',
      'текст\n' + STORYGO_DIVIDER, 'текст\n─────────\nфинал',
      'текст\r\n' + STORYGO_DIVIDER + '\r\nфинал',
    ]) {
      expect(() => maxStoryParts('Заголовок', rest)).toThrow();
    }
    expect(() => maxStoryParts('Заголовок\n' + STORYGO_DIVIDER, 'Привет')).toThrow();
    expect(() => maxStoryParts('Заголовок', 123)).toThrow();
  });

  it('enforces UTF-16 MAX limits without truncating emoji or long titles', () => {
    expect(maxStoryParts('Заголовок', '😀'.repeat(2000)).parts[1]).toHaveLength(4000);
    expect(() => maxStoryParts('Заголовок', '😀'.repeat(2001))).toThrow();
    expect(() => maxStoryParts('А'.repeat(161), 'Вторая')).toThrow();
  });
});
