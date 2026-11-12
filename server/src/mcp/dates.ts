/** Date and recurrence maths for MCP writes, matching the app's domain rules. */

import type { RecurrenceFreq, RecurrenceRule } from './types.js';

export const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

export function toISODate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function fromISODate(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1);
}

export function isValidISODate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return toISODate(fromISODate(value)) === value;
}

export function isValidTime(value: string): boolean {
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) return false;
  return Number(match[1]) <= 23 && Number(match[2]) <= 59;
}

export function addDays(iso: string, days: number): string {
  const date = fromISODate(iso);
  date.setDate(date.getDate() + days);
  return toISODate(date);
}

export function addMonths(iso: string, months: number): string {
  const date = fromISODate(iso);
  const targetDay = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + months);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(targetDay, lastDay));
  return toISODate(date);
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

export function startOfWeek(iso: string): string {
  const day = weekdayOf(iso);
  return addDays(iso, -((day + 6) % 7));
}

function matchesWeekday(rule: RecurrenceRule, iso: string): boolean {
  if (rule.byWeekday.length === 0) return true;
  return rule.byWeekday.includes(weekdayOf(iso));
}

function nextWeekly(rule: RecurrenceRule, currentISO: string): string {
  if (rule.byWeekday.length === 0) {
    return addDays(currentISO, 7 * Math.max(1, rule.interval));
  }
  const anchor = startOfWeek(currentISO);
  const limit = 7 * Math.max(1, rule.interval) * 8;
  for (let index = 1; index <= limit; index += 1) {
    const candidate = addDays(currentISO, index);
    if (!matchesWeekday(rule, candidate)) continue;
    const weeks = daysBetween(anchor, startOfWeek(candidate)) / 7;
    if (weeks % Math.max(1, rule.interval) === 0) return candidate;
  }
  return addDays(currentISO, 7 * Math.max(1, rule.interval));
}

function nextMonthly(rule: RecurrenceRule, currentISO: string): string {
  const interval = Math.max(1, rule.interval);
  const current = fromISODate(currentISO);
  const targetDay = rule.byMonthDay[0] ?? current.getDate();

  for (let step = 0; step <= 120; step += 1) {
    const cursor = new Date(current.getFullYear(), current.getMonth() + step * interval, 1);
    const lastDay = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
    const day = Math.min(targetDay, lastDay);
    const candidate = new Date(cursor.getFullYear(), cursor.getMonth(), day);
    if (candidate.getTime() > current.getTime()) return toISODate(candidate);
  }
  return addMonths(currentISO, interval);
}

export function nextOccurrence(rule: RecurrenceRule, currentISO: string): string {
  switch (rule.freq) {
    case 'daily':
      return addDays(currentISO, Math.max(1, rule.interval));
    case 'weekly':
      return nextWeekly(rule, currentISO);
    case 'monthly':
      return nextMonthly(rule, currentISO);
    case 'yearly':
      return addYears(currentISO, Math.max(1, rule.interval));
  }
}

export function isExhausted(rule: RecurrenceRule, nextISO: string, occurrences: number): boolean {
  if (rule.until && nextISO > rule.until) return true;
  if (rule.count !== null && occurrences >= rule.count) return true;
  return false;
}

/** Keeps an end date the same distance from the new start date. */
export function shiftRange(startISO: string, endISO: string, newStartISO: string): string {
  const start = Date.parse(`${startISO}T00:00:00Z`);
  const end = Date.parse(`${endISO}T00:00:00Z`);
  const shifted = Date.parse(`${newStartISO}T00:00:00Z`) + (end - start);
  return new Date(shifted).toISOString().slice(0, 10);
}

export function createRecurrence(freq: RecurrenceFreq, dateISO: string): RecurrenceRule {
  const rule: RecurrenceRule = {
    freq,
    interval: 1,
    byWeekday: [],
    byMonthDay: [],
    until: null,
    count: null,
  };
  if (freq === 'weekly') rule.byWeekday = [weekdayOf(dateISO)];
  if (freq === 'monthly' || freq === 'yearly') {
    rule.byMonthDay = [fromISODate(dateISO).getDate()];
  }
  return rule;
}
