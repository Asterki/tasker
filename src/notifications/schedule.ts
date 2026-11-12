/**
 * Turns tasks into the exact ntfy reminders that should exist right now.
 *
 * The app is local-first, so the schedule is computed from the tasks in
 * IndexedDB and pushed to ntfy by the browser. Nothing else knows your due
 * dates. Tasks with a time produce one reminder at that time; tasks with a date
 * but no time produce a configurable number of reminders spread across the day.
 */

import type { Settings, Task } from '../domain/types';
import { formatDateShort, formatTime, spanDates, zonedDateTimeToUtc } from '../domain/date';
import { isValidTopic, normalizeNtfyUrl } from './ntfy';

/**
 * How far ahead to publish. ntfy.sh caps scheduled delivery at three days by
 * default, so two days leaves room for clock skew. The app re-arms on launch,
 * on focus, on reconnect and every six hours while open.
 */
export const REMINDER_HORIZON_MS = 2 * 24 * 60 * 60 * 1000;

/** Reminder times used for all-day tasks, by reminders per day. */
export const ALL_DAY_SLOTS: Record<number, string[]> = {
  1: ['09:00'],
  2: ['09:00', '18:00'],
  3: ['09:00', '13:00', '18:00'],
  4: ['09:00', '12:00', '16:00', '20:00'],
  5: ['08:00', '11:00', '14:00', '17:00', '20:00'],
};

export function allDaySlots(count: number): string[] {
  const clamped = Math.min(5, Math.max(1, Math.round(count || 1)));
  return ALL_DAY_SLOTS[clamped] ?? ALL_DAY_SLOTS[1];
}

/** True when a topic and server URL are present and syntactically usable. */
export function notificationsConfigured(settings: Settings): boolean {
  const { enabled, serverUrl, topic } = settings.notifications;
  return enabled && Boolean(normalizeNtfyUrl(serverUrl)) && isValidTopic(topic);
}

export interface DesiredReminder {
  /** Deterministic ntfy sequence id, so edits replace the scheduled message. */
  id: string;
  taskId: string;
  remindAt: number;
  title: string;
  message: string;
  /** ntfy message priority: 1 (min) … 5 (max). */
  priority: number;
  tags: string[];
  click: string;
  /** Stored locally to detect content changes without re-publishing. */
  fingerprint: string;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** `r-<task uuid>-<YYYYMMDD>-<HHMM>`; stable across devices and edits. */
function sequenceId(taskId: string, dateISO: string, slot: string): string {
  return `r-${taskId.replace(/-/g, '').slice(0, 32)}-${dateISO.replace(/-/g, '')}-${slot}`;
}

function buildReminder(
  task: Task,
  projectName: string | null,
  dateISO: string,
  slotTime: string,
  timed: boolean,
  slotIndex: number,
  slotCount: number,
  timeZone: string,
): DesiredReminder | null {
  const remindAt = zonedDateTimeToUtc(dateISO, slotTime, timeZone);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  const meta = [
    projectName ?? 'Inbox',
    task.place ? `@${task.place}` : null,
    `P${task.priority}`,
  ]
    .filter(Boolean)
    .join(' · ');

  const when = timed
    ? `${formatDateShort(dateISO)} at ${formatTime(slotTime)}`
    : `${formatDateShort(dateISO)} · all-day`;
  const slotLabel = !timed && slotCount > 1 ? ` · reminder ${slotIndex + 1}/${slotCount}` : '';
  const title = truncate(task.title.trim() || 'Untitled task', 120);
  const message = `${meta}\n${when}${slotLabel}`;
  const click = origin ? `${origin}/?task=${encodeURIComponent(task.id)}` : '';
  const priority = Math.max(1, Math.min(5, 6 - task.priority));

  const tags = timed ? ['alarm_clock'] : ['calendar'];
  if (task.priority === 1) tags.unshift('rotating_light');
  else if (task.priority === 2) tags.unshift('warning');

  return {
    id: sequenceId(task.id, dateISO, slotTime.replace(':', '')),
    taskId: task.id,
    remindAt,
    title,
    message,
    priority,
    tags,
    click,
    fingerprint: [remindAt, title, message, priority, click].join('|'),
  };
}

/**
 * Everything that should be scheduled in `[now, now + horizon]`, sorted by
 * delivery time. Completed, undated, muted and past tasks are skipped.
 */
export function computeReminders(
  tasks: Task[],
  projects: { id: string; name: string }[],
  settings: Settings,
  now = Date.now(),
  horizonMs = REMINDER_HORIZON_MS,
): DesiredReminder[] {
  if (!notificationsConfigured(settings)) return [];

  const timeZone = settings.timezone;
  const slots = allDaySlots(settings.notifications.allDayCount);
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const reminders: DesiredReminder[] = [];

  for (const task of tasks) {
    if (task.completed || !task.date || task.reminder === false) continue;

    const projectName = task.projectId ? projectNames.get(task.projectId) ?? null : null;
    const timed = Boolean(task.time) && !task.allDay;

    if (timed) {
      const reminder = buildReminder(
        task,
        projectName,
        task.date,
        task.time as string,
        true,
        0,
        1,
        timeZone,
      );
      if (reminder && reminder.remindAt > now + 10_000 && reminder.remindAt - now <= horizonMs) {
        reminders.push(reminder);
      }
      continue;
    }

    for (const dateISO of spanDates(task.date, task.endDate)) {
      for (let index = 0; index < slots.length; index += 1) {
        const reminder = buildReminder(
          task,
          projectName,
          dateISO,
          slots[index],
          false,
          index,
          slots.length,
          timeZone,
        );
        if (reminder && reminder.remindAt > now + 10_000 && reminder.remindAt - now <= horizonMs) {
          reminders.push(reminder);
        }
      }
    }
  }

  return reminders.sort((a, b) => a.remindAt - b.remindAt);
}
