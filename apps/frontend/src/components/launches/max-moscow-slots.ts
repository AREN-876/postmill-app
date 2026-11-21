/**
 * Editorial MAX channels use one fixed IANA timezone: Europe/Moscow, UTC+03:00.
 *
 * Integration.postingTimes is the EXISTING Postmill storage format: a UTC
 * minute-of-day offset. These helpers change only presentation/input for MAX;
 * they do not reinterpret or rewrite stored slots and do not schedule a post.
 */
const MINUTES_PER_DAY = 24 * 60;
const MOSCOW_UTC_OFFSET_MINUTES = 3 * 60;

function wrapMinute(value: number): number {
  return ((value % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

export function moscowToPostingMinute(hour: number, minute: number): number {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 ||
      !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error('Invalid Moscow posting time');
  }
  return wrapMinute(hour * 60 + minute - MOSCOW_UTC_OFFSET_MINUTES);
}

export function postingMinuteToMoscowMinute(utcMinute: number): number {
  if (!Number.isInteger(utcMinute) || !Number.isSafeInteger(utcMinute)) {
    throw new Error('Invalid stored posting time');
  }
  // An old client may have saved a negative UTC offset for local midnight.
  // Retain the historical instant and normalize the display only.
  return wrapMinute(utcMinute + MOSCOW_UTC_OFFSET_MINUTES);
}

export function postingMinuteToMoscowLabel(utcMinute: number): string {
  const localMinute = postingMinuteToMoscowMinute(utcMinute);
  return `${String(Math.floor(localMinute / 60)).padStart(2, '0')}:${String(localMinute % 60).padStart(2, '0')}`;
}
