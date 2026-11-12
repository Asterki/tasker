/**
 * ntfy reminder engine.
 *
 * Reconciles the reminders that *should* be scheduled (derived from tasks and
 * settings) with the ledger of messages this device has published. Edits
 * republish under the same sequence id, deletions and completions cancel, and
 * every pass re-arms the next two days so a closed tab still gets reminders.
 */

import { scheduledReminders, type ScheduledReminderRecord } from '../db/database';
import type { Project, Settings, Task } from '../domain/types';
import { computeReminders, notificationsConfigured, REMINDER_HORIZON_MS } from './schedule';
import {
  cancelReminder,
  NtfyError,
  normalizeNtfyUrl,
  publishReminder,
  sendTestNotification,
} from './ntfy';

export interface NotificationStatus {
  state: 'off' | 'idle' | 'scheduling' | 'error';
  configured: boolean;
  scheduled: number;
  lastSyncAt: number;
  error: string | null;
}

const idleStatus: NotificationStatus = {
  state: 'off',
  configured: false,
  scheduled: 0,
  lastSyncAt: 0,
  error: null,
};

let status: NotificationStatus = { ...idleStatus };
let current: { settings: Settings; tasks: Task[]; projects: Project[] } | null = null;
let debounceTimer: number | null = null;
let running = false;
let rerun = false;
let bound = false;

const listeners = new Set<(status: NotificationStatus) => void>();

function publishStatus(patch: Partial<NotificationStatus>): void {
  status = { ...status, ...patch };
  for (const listener of listeners) listener({ ...status });
}

export function getNotificationStatus(): NotificationStatus {
  return { ...status };
}

export function subscribeNotifications(listener: (status: NotificationStatus) => void): () => void {
  listeners.add(listener);
  listener({ ...status });
  return () => {
    listeners.delete(listener);
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Reminder scheduling failed.';
}

function bindGlobalListeners(): void {
  if (bound || typeof window === 'undefined') return;
  bound = true;

  window.addEventListener('online', () => {
    void run();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void run();
  });
  // Keep the rolling two-day window armed while a tab stays open for days.
  window.setInterval(() => void run(), 6 * 60 * 60 * 1000);
}

/** Debounced entry point called whenever tasks, projects or settings change. */
export function requestNotificationSync(
  settings: Settings,
  tasks: Task[],
  projects: Project[],
): void {
  current = { settings, tasks, projects };
  bindGlobalListeners();
  if (debounceTimer !== null) window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => {
    debounceTimer = null;
    void run();
  }, 900);
}

/** Immediate pass, used by the “Refresh schedule” button and tests. */
export function syncNotificationsNow(
  settings: Settings,
  tasks: Task[],
  projects: Project[],
): Promise<void> {
  current = { settings, tasks, projects };
  bindGlobalListeners();
  if (debounceTimer !== null) {
    window.clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  return run();
}

export async function testNotification(settings: Settings): Promise<void> {
  await sendTestNotification(settings.notifications, settings.timezone);
}

/**
 * Best-effort cancellation used before a reset or backup import, while each
 * record still knows the server/topic/token it was published to.
 */
export async function resetNotificationSchedule(): Promise<void> {
  const records = await scheduledReminders.all();
  for (const record of records) {
    if (record.remindAt <= Date.now()) {
      await scheduledReminders.remove(record.id);
      continue;
    }
    try {
      await cancelReminder(
        { serverUrl: record.serverUrl, topic: record.topic, token: record.token },
        record.id,
      );
      await scheduledReminders.remove(record.id);
    } catch {
      // Keep the record so the next reconcile retries with its captured
      // server/topic/token, even if settings were reset in the meantime.
      await scheduledReminders
        .put({ ...record, state: 'error', updatedAt: Date.now() })
        .catch(() => undefined);
    }
  }
  publishStatus({ ...idleStatus });
}

async function run(): Promise<void> {
  if (running) {
    rerun = true;
    return;
  }
  const input = current;
  if (!input) return;

  running = true;
  publishStatus({ state: 'scheduling' });

  let failure: string | null = null;
  try {
    failure = await reconcile(input.settings, input.tasks, input.projects);
  } catch (error) {
    failure = errorMessage(error);
  }

  const records = await scheduledReminders.all().catch(() => [] as ScheduledReminderRecord[]);
  const configured = notificationsConfigured(input.settings);
  publishStatus({
    state: failure ? 'error' : configured ? 'idle' : 'off',
    configured,
    scheduled: records.filter((record) => record.state === 'scheduled').length,
    lastSyncAt: Date.now(),
    error: failure,
  });

  running = false;
  if (rerun) {
    rerun = false;
    void run();
  }
}

/** Returns a human-readable failure, or null when everything converged. */
async function reconcile(
  settings: Settings,
  tasks: Task[],
  projects: Project[],
): Promise<string | null> {
  const stored = await scheduledReminders.all();
  const existingById = new Map(stored.map((record) => [record.id, record]));

  // A half-typed server URL or topic should not cancel an existing schedule.
  // Only an explicit disable clears everything.
  if (settings.notifications.enabled && !notificationsConfigured(settings)) return null;

  const desired = notificationsConfigured(settings)
    ? computeReminders(tasks, projects, settings, Date.now(), REMINDER_HORIZON_MS)
    : [];
  const desiredById = new Map(desired.map((reminder) => [reminder.id, reminder]));
  const target = {
    serverUrl: normalizeNtfyUrl(settings.notifications.serverUrl),
    topic: settings.notifications.topic.trim(),
    token: settings.notifications.token.trim(),
  };

  let failure: string | null = null;

  // Cancel anything that is no longer wanted: deleted task, completed task,
  // disabled reminders, changed all-day count, or a task that moved past the
  // rolling scheduling window.
  for (const record of stored) {
    if (desiredById.has(record.id)) continue;

    // Already delivered. Remove the ledger entry, but do not DELETE it: that
    // would clear the notification the user may still be looking at.
    if (record.remindAt <= Date.now()) {
      await scheduledReminders.remove(record.id);
      continue;
    }

    try {
      await cancelReminder(
        { serverUrl: record.serverUrl, topic: record.topic, token: record.token },
        record.id,
      );
      await scheduledReminders.remove(record.id);
    } catch (error) {
      failure ??= errorMessage(error);
      await scheduledReminders
        .put({ ...record, state: 'error', updatedAt: Date.now() })
        .catch(() => undefined);
    }
  }

  // Create or replace the remaining reminders.
  for (const reminder of desired) {
    const existing = existingById.get(reminder.id);
    const sameTarget =
      existing !== undefined &&
      existing.serverUrl === target.serverUrl &&
      existing.topic === target.topic;

    if (
      existing &&
      existing.state === 'scheduled' &&
      existing.fingerprint === reminder.fingerprint &&
      sameTarget
    ) {
      continue;
    }

    // A topic or server change means the old scheduled message lives elsewhere;
    // try to remove it before publishing the replacement.
    if (existing && !sameTarget) {
      try {
        await cancelReminder(
          { serverUrl: existing.serverUrl, topic: existing.topic, token: existing.token },
          existing.id,
        );
      } catch (error) {
        failure ??= errorMessage(error);
      }
    }

    try {
      await publishReminder(settings.notifications, settings.timezone, reminder);
      await scheduledReminders.put({
        id: reminder.id,
        taskId: reminder.taskId,
        remindAt: reminder.remindAt,
        fingerprint: reminder.fingerprint,
        state: 'scheduled',
        serverUrl: target.serverUrl,
        topic: target.topic,
        token: target.token,
        updatedAt: Date.now(),
      });
    } catch (error) {
      failure ??= errorMessage(error);
      await scheduledReminders
        .put({
          id: reminder.id,
          taskId: reminder.taskId,
          remindAt: reminder.remindAt,
          fingerprint: reminder.fingerprint,
          state: 'error',
          serverUrl: target.serverUrl,
          topic: target.topic,
          token: target.token,
          updatedAt: Date.now(),
        })
        .catch(() => undefined);

      // A network/CORS failure will repeat for every task; stop this pass and
      // retry when the browser is back online or the tab regains focus.
      if (error instanceof NtfyError && error.status === null) break;
    }
  }

  return failure;
}
