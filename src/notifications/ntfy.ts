/**
 * Minimal ntfy publisher.
 *
 * Reminders are published as JSON to the ntfy root URL. Using JSON (rather
 * than custom headers) keeps Unicode task titles intact and lets us pass the
 * `delay`, `timezone` and `sequence_id` fields in one place.
 */

import type { NotificationSettings } from '../domain/types';

const REQUEST_TIMEOUT_MS = 15_000;
const TOPIC_PATTERN = /^[-_A-Za-z0-9]{1,64}$/;

export class NtfyError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'NtfyError';
  }
}

/** Accepts `ntfy.sh`, `https://ntfy.sh/`, etc. Returns '' when unusable. */
export function normalizeNtfyUrl(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    return '';
  }
}

export function isValidTopic(topic: string): boolean {
  return TOPIC_PATTERN.test((topic ?? '').trim());
}

interface Target {
  serverUrl: string;
  topic: string;
  token: string;
}

function targetOf(settings: NotificationSettings): Target {
  return {
    serverUrl: normalizeNtfyUrl(settings.serverUrl),
    topic: settings.topic.trim(),
    token: settings.token.trim(),
  };
}

function headersFor(target: Target): HeadersInit {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (target.token) headers.authorization = `Bearer ${target.token}`;
  return headers;
}

async function send(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new NtfyError('The ntfy server timed out.');
    }
    throw new NtfyError('Could not reach the ntfy server. Check the URL and your connection.');
  } finally {
    window.clearTimeout(timer);
  }
}

async function ensureOk(response: Response, action: string): Promise<void> {
  if (response.ok) return;
  let detail = '';
  try {
    const body = (await response.json()) as { error?: string };
    detail = body.error ?? '';
  } catch {
    /* the response was not JSON */
  }
  const status = response.status;
  throw new NtfyError(
    detail
      ? `${action} failed (${status}): ${detail}`
      : `${action} failed with HTTP ${status}.`,
    status,
  );
}

export interface NtfyReminder {
  id: string;
  remindAt: number;
  title: string;
  message: string;
  priority: number;
  tags: string[];
  click: string;
}

/**
 * Publishes a scheduled reminder. Re-publishing the same `sequence_id` replaces
 * the existing scheduled message on the server, which is how edits work.
 */
export async function publishReminder(
  settings: NotificationSettings,
  timeZone: string,
  reminder: NtfyReminder,
): Promise<void> {
  const target = targetOf(settings);
  if (!target.serverUrl) throw new NtfyError('Add a valid ntfy server URL.');
  if (!isValidTopic(target.topic)) throw new NtfyError('Add a valid ntfy topic.');

  const response = await send(`${target.serverUrl}/`, {
    method: 'POST',
    headers: headersFor(target),
    body: JSON.stringify({
      topic: target.topic,
      title: reminder.title,
      message: reminder.message,
      priority: reminder.priority,
      tags: reminder.tags,
      click: reminder.click || undefined,
      delay: new Date(reminder.remindAt).toISOString(),
      timezone: timeZone,
      sequence_id: reminder.id,
    }),
  });
  await ensureOk(response, 'Scheduling reminder');
}

/** Cancels a scheduled reminder. A missing message is already cancelled. */
export async function cancelReminder(
  target: { serverUrl: string; topic: string; token: string },
  sequenceId: string,
): Promise<void> {
  const serverUrl = normalizeNtfyUrl(target.serverUrl);
  if (!serverUrl || !isValidTopic(target.topic)) return;

  const response = await send(
    `${serverUrl}/${encodeURIComponent(target.topic.trim())}/${encodeURIComponent(sequenceId)}`,
    {
      method: 'DELETE',
      headers: target.token ? { authorization: `Bearer ${target.token}` } : undefined,
    },
  );
  if (response.status === 404) return;
  await ensureOk(response, 'Cancelling reminder');
}

/** Publishes an immediate notification so the user can verify the setup. */
export async function sendTestNotification(
  settings: NotificationSettings,
  timeZone: string,
): Promise<void> {
  const target = targetOf(settings);
  if (!target.serverUrl) throw new NtfyError('Add a valid ntfy server URL.');
  if (!isValidTopic(target.topic)) throw new NtfyError('Add a valid ntfy topic.');

  const response = await send(`${target.serverUrl}/`, {
    method: 'POST',
    headers: headersFor(target),
    body: JSON.stringify({
      topic: target.topic,
      title: 'Tasker test notification',
      message: `ntfy is connected. Reminders use the ${timeZone} time zone.`,
      priority: 3,
      tags: ['white_check_mark'],
      sequence_id: 'tasker-test',
    }),
  });
  await ensureOk(response, 'Sending test notification');
}
