import { describe, expect, it } from 'vitest';
import {
  moscowToPostingMinute,
  postingMinuteToMoscowLabel,
  postingMinuteToMoscowMinute,
} from './max-moscow-slots';

describe('Editorial MAX posting time — Europe/Moscow (UTC+03:00)', () => {
  it('encodes exactly one slot per whole story using existing UTC-minute storage', () => {
    expect([8, 13, 20].map((h) => moscowToPostingMinute(h, 0)))
      .toEqual([300, 600, 1020]);
    expect([300, 600, 1020].map(postingMinuteToMoscowLabel))
      .toEqual(['08:00', '13:00', '20:00']);
  });

  it('handles local day boundaries without negative stored minutes', () => {
    expect(moscowToPostingMinute(0, 0)).toBe(1260);
    expect(moscowToPostingMinute(2, 59)).toBe(1439);
    expect(moscowToPostingMinute(3, 0)).toBe(0);
    expect(postingMinuteToMoscowLabel(1260)).toBe('00:00');
    expect(postingMinuteToMoscowLabel(-180)).toBe('00:00');
    expect(postingMinuteToMoscowMinute(1439)).toBe(179);
  });

  it('rejects invalid times rather than quietly storing broken grid entries', () => {
    expect(() => moscowToPostingMinute(24, 0)).toThrow();
    expect(() => moscowToPostingMinute(10, 60)).toThrow();
    expect(() => moscowToPostingMinute(8.5, 0)).toThrow();
    expect(() => postingMinuteToMoscowLabel(NaN)).toThrow();
  });
});
