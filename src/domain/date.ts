/**
 * Date + time helpers for the Tasker domain.
 *
 * The app treats a task date as a calendar day (`YYYY-MM-DD`) and a task time as
 * a wall-clock string (`HH:mm`). Everything here works in the user's local time
 * zone; there is no timezone juggling because the app is single-user and local.
 */

export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEKDAYS_MIN = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/** Pad a number to two digits. */
function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function toISODate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function fromISODate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

export function todayISO(): string {
  return toISODate(new Date());
}

export function isValidISODate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = fromISODate(value);
  return toISODate(d) === value;
}

export function addDays(iso: string, days: number): string {
  const d = fromISODate(iso);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

export function addMonths(iso: string, months: number): string {
  const d = fromISODate(iso);
  const targetDay = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  // Clamp to the last day of the target month (e.g. Jan 31 + 1 month -> Feb 28).
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(targetDay, lastDay));
  return toISODate(d);
}

export function addYears(iso: string, years: number): string {
  return addMonths(iso, years * 12);
}

export function daysBetween(fromISO: string, toISO: string): number {
  const a = fromISODate(fromISO).getTime();
  const b = fromISODate(toISO).getTime();
  return Math.round((b - a) / 86_400_000);
}

export function weekdayOf(iso: string): number {
  return fromISODate(iso).getDay();
}

/** Monday-first start of week. */
export function startOfWeek(iso: string): string {
  const day = weekdayOf(iso);
  const delta = (day + 6) % 7;
  return addDays(iso, -delta);
}

export function endOfWeek(iso: string): string {
  return addDays(startOfWeek(iso), 6);
}

export function startOfMonth(iso: string): string {
  const d = fromISODate(iso);
  return toISODate(new Date(d.getFullYear(), d.getMonth(), 1));
}

export function isToday(iso: string): boolean {
  return iso === todayISO();
}

/** Inclusive list of ISO dates. */
export function dateRange(startISO: string, endISO: string): string[] {
  const out: string[] = [];
  let cursor = startISO;
  while (cursor <= endISO) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}

/**
 * Every calendar day a task occupies, clamped to `max` days as a safety valve
 * for absurd ranges. Returns `[]` when there is no start date.
 */
export function spanDates(dateISO: string | null, endISO: string | null, max = 120): string[] {
  if (!dateISO) return [];
  const last = endISO && endISO > dateISO ? endISO : dateISO;
  const out: string[] = [];
  let cursor = dateISO;
  while (cursor <= last && out.length < max) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}

/** Number of calendar days a task covers (1 for a same-day task). */
export function spanLength(dateISO: string | null, endISO: string | null): number {
  if (!dateISO) return 0;
  const last = endISO && endISO > dateISO ? endISO : dateISO;
  return daysBetween(dateISO, last) + 1;
}

/**
 * Human label for a task's schedule.
 * `Oct 24` · `Today` · `Oct 24 – 26` · `Oct 24 – Nov 2`
 */
export function formatTaskRange(
  dateISO: string | null,
  endISO: string | null,
  relative = true,
): string {
  if (!dateISO) return 'No date';
  const multiDay = Boolean(endISO && endISO > dateISO);
  if (!multiDay) return relative ? relativeDayLabel(dateISO) : formatDateShort(dateISO);

  const start = relative ? relativeDayLabel(dateISO) : formatDateShort(dateISO);
  const sameYear = dateISO.slice(0, 4) === (endISO as string).slice(0, 4);
  const end = formatDateShort(endISO as string);
  return sameYear ? `${start} – ${end}` : `${start} ${dateISO.slice(0, 4)} – ${end} ${(endISO as string).slice(0, 4)}`;
}

/** A 6x7 grid of ISO dates covering the month that contains `iso`. */
export function monthMatrix(iso: string): string[][] {
  const first = startOfMonth(iso);
  const gridStart = startOfWeek(first);
  const weeks: string[][] = [];
  let cursor = gridStart;
  for (let w = 0; w < 6; w += 1) {
    const week: string[] = [];
    for (let d = 0; d < 7; d += 1) {
      week.push(cursor);
      cursor = addDays(cursor, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

export function monthLabel(iso: string): string {
  const d = fromISODate(iso);
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function formatDate(iso: string): string {
  const d = fromISODate(iso);
  return `${WEEKDAYS_SHORT[d.getDay()]}, ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}, ${d.getFullYear()}`;
}

export function formatDateShort(iso: string): string {
  const d = fromISODate(iso);
  return `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
}

/** Human-friendly label: Today / Tomorrow / Yesterday / weekday / date. */
export function relativeDayLabel(iso: string): string {
  const diff = daysBetween(todayISO(), iso);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff < 7) return WEEKDAYS_SHORT[weekdayOf(iso)];
  if (diff < -1 && diff > -7) return `Last ${WEEKDAYS_SHORT[weekdayOf(iso)]}`;
  return formatDateShort(iso);
}

/** 24h `HH:mm` -> `3:00 PM`. */
export function formatTime(time: string): string {
  const [h, m] = time.split(':').map(Number);
  const suffix = h < 12 ? 'AM' : 'PM';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour} ${suffix}` : `${hour}:${pad(m)} ${suffix}`;
}

export function combineDateTime(dateISO: string, time: string | null, allDay: boolean): Date {
  const d = fromISODate(dateISO);
  if (allDay || !time) {
    d.setHours(0, 0, 0, 0);
    return d;
  }
  const [h, m] = time.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d;
}

/** Absolute ms timestamp for a task occurrence, or null when it has no date. */
export function occurrenceTimestamp(
  dateISO: string | null,
  time: string | null,
  allDay: boolean,
): number | null {
  if (!dateISO) return null;
  return combineDateTime(dateISO, time, allDay).getTime();
}

const NAMED_TIMES: Record<string, string> = {
  noon: '12:00',
  midday: '12:00',
  midnight: '00:00',
  morning: '09:00',
  afternoon: '14:00',
  evening: '18:00',
  night: '21:00',
};

/**
 * Parse a loose time token into `HH:mm`.
 * Accepts `3pm`, `3:30 pm`, `15:00`, `1500`, `at 7`, `noon`, `evening`.
 */
export function parseTimeToken(raw: string): string | null {
  const token = raw.trim().toLowerCase().replace(/^at\s+/, '');
  if (!token) return null;
  if (NAMED_TIMES[token]) return NAMED_TIMES[token];

  const match = token.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3];

  if (minute > 59) return null;
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (!meridiem && hour > 23) return null;
  if (hour > 23) return null;

  return `${pad(hour)}:${pad(minute)}`;
}

/** `HH:mm` -> total minutes since midnight. */
export function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/* ── Timezones ───────────────────────────────────────────────────────────── */

/** The IANA zone reported by the device, with a UTC fallback. */
export function deviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** True when `timeZone` is an IANA name the browser understands. */
export function isValidTimezone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Milliseconds the zone is ahead of UTC at `timestamp`. Positive east of
 * Greenwich, negative west.
 */
const zoneClockFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneClockFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = zoneClockFormatters.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  zoneClockFormatters.set(timeZone, formatter);
  return formatter;
}

function timezoneOffset(timestamp: number, timeZone: string): number {
  const parts = zoneClockFormatter(timeZone).formatToParts(new Date(timestamp));

  const pick = (type: string): number => {
    const value = parts.find((part) => part.type === type)?.value;
    return value ? Number(value) : 0;
  };

  const wallClockAsUtc = Date.UTC(
    pick('year'),
    pick('month') - 1,
    pick('day'),
    pick('hour'),
    pick('minute'),
    pick('second'),
  );
  return wallClockAsUtc - timestamp;
}

/**
 * Converts a wall-clock date (`YYYY-MM-DD`) and time (`HH:mm`) in `timeZone`
 * to an absolute epoch timestamp. DST gaps resolve forwards and ambiguous
 * times resolve to the first matching offset.
 */
export function zonedDateTimeToUtc(dateISO: string, time: string, timeZone: string): number {
  const zone = isValidTimezone(timeZone) ? timeZone : deviceTimezone();
  const [year, month, day] = dateISO.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const naive = Date.UTC(year, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0, 0, 0);

  const firstOffset = timezoneOffset(naive, zone);
  let timestamp = naive - firstOffset;
  const secondOffset = timezoneOffset(timestamp, zone);
  if (secondOffset !== firstOffset) timestamp = naive - secondOffset;
  return timestamp;
}

/** Human-readable clock in a zone, e.g. "Mon, Nov 16, 9:00 AM". */
export function formatInTimezone(timestamp: number, timeZone: string): string {
  const zone = isValidTimezone(timeZone) ? timeZone : deviceTimezone();
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(timestamp));
}
