import { describe, expect, it } from 'vitest';
import { maxStoryDraft, maxStoryParts, STORYGO_DIVIDER } from './max-story';

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

  it('accepts a full three-part story from one input without losing whitespace', () => {
    const first = 'Работал за начальника, числился инженером\n\n— Денис, тебя ищут.';
    const second = 'Второй эпизод\n\n';
    const third = '\nФинал.';
    const source = [first, second, third].join('\n' + STORYGO_DIVIDER + '\n');
    const parsed = maxStoryDraft(source);
    expect(parsed.title).toBe('Работал за начальника, числился инженером');
    expect(parsed.firstPart).toBe(first);
    expect(parsed.continuationText).toBe([second, third].join('\n' + STORYGO_DIVIDER + '\n'));
    expect(parsed.parts).toEqual([first, second, third]);
  });

  it('keeps the old separate continuation field compatible', () => {
    const rest = 'Вторая\n' + STORYGO_DIVIDER + '\nТретья';
    expect(maxStoryDraft('Заголовок\nНачало', rest)).toMatchObject({
      parts: ['Заголовок\nНачало', 'Вторая', 'Третья'],
      continuationText: rest,
    });
  });

  it('rejects ambiguous, empty, wrong-delimiter and too-long full stories', () => {
    expect(() => maxStoryDraft('Заголовок\nТолько одна часть')).toThrow();
    expect(() => maxStoryDraft('Заголовок\n─────────\nВторая')).toThrow();
    expect(() => maxStoryDraft('Заголовок\n' + STORYGO_DIVIDER + '\n')).toThrow();
    expect(() => maxStoryDraft('Заголовок\n' + STORYGO_DIVIDER + '\nВторая', 'Третья')).toThrow();
    expect(() => maxStoryDraft('Заголовок\n' + STORYGO_DIVIDER + '\n' + '😀'.repeat(2001))).toThrow();
    expect(() => maxStoryDraft('А'.repeat(161) + '\n' + STORYGO_DIVIDER + '\nВторая')).toThrow();
    expect(maxStoryDraft('Заголовок\n' + STORYGO_DIVIDER + '\n' + '😀'.repeat(2000)).parts[1]).toHaveLength(4000);
  });

  it('enforces UTF-16 MAX limits without truncating emoji or long titles', () => {
    expect(maxStoryParts('Заголовок', '😀'.repeat(2000)).parts[1]).toHaveLength(4000);
    expect(() => maxStoryParts('Заголовок', '😀'.repeat(2001))).toThrow();
    expect(() => maxStoryParts('А'.repeat(161), 'Вторая')).toThrow();
  });
});
