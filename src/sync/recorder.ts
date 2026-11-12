/**
 * Mirrors every local mutation into the sync outbox.
 *
 * The recorder is registered once by the engine and stays dormant until sync is
 * configured, so local-only users never accumulate outbox rows.
 */

import {
  clearOutboxForEntity,
  normalizeProject,
  normalizeTask,
  putOutbox,
  putVersion,
  setMutationListener,
  writeSyncState,
  type EntityKind,
  type MutationEvent,
  type StoreName,
} from '../db/database';
import type { Project, Settings, Task } from '../domain/types';
import type { HlcClock } from './hlc';
import type { SyncConfig } from './types';

const KIND_BY_STORE: Record<StoreName, EntityKind> = {
  tasks: 'task',
  categories: 'category',
  projects: 'project',
  places: 'place',
  settings: 'settings',
};

let config: SyncConfig | null = null;
let clock: HlcClock | null = null;
let chain: Promise<void> = Promise.resolve();

export function configureRecorder(nextConfig: SyncConfig | null, nextClock: HlcClock | null): void {
  config = nextConfig;
  clock = nextClock;
  setMutationListener(nextConfig ? recordMutation : null);
}

export function entityPayload(kind: EntityKind, value: unknown): unknown {
  if (kind === 'settings') {
    const settings = value as Settings;
    return {
      theme: settings.theme,
      defaultProjectId: settings.defaultProjectId,
      soundEnabled: settings.soundEnabled,
      hapticsEnabled: settings.hapticsEnabled,
      timezone: settings.timezone,
      notifications: settings.notifications,
      progress: settings.progress,
    };
  }
  if (kind === 'task') return normalizeTask(value as Task);
  if (kind === 'project') return normalizeProject(value as Project);
  return value;
}

async function persist(event: MutationEvent, hlc: string, active: SyncConfig): Promise<void> {
  const kind = KIND_BY_STORE[event.store];

  for (const id of event.deletes) {
    const entityId = kind === 'settings' ? 'app' : id;
    await clearOutboxForEntity(kind, entityId);
    await putOutbox({
      changeId: crypto.randomUUID(),
      entityType: kind,
      entityId,
      hlc,
      deleted: true,
      payload: null,
    });
    await putVersion({ entityType: kind, entityId, hlc, deleted: true });
  }

  for (const value of event.puts) {
    const record = value as { id?: string };
    const entityId = kind === 'settings' ? 'app' : record.id;
    if (!entityId) continue;

    await clearOutboxForEntity(kind, entityId);
    await putOutbox({
      changeId: crypto.randomUUID(),
      entityType: kind,
      entityId,
      hlc,
      deleted: false,
      payload: entityPayload(kind, value),
    });
    await putVersion({ entityType: kind, entityId, hlc, deleted: false });
  }

  active.lastHlc = hlc;
  await writeSyncState('app', active);
}

/** Registered with the database layer; runs mutations through a serial queue. */
export function recordMutation(event: MutationEvent): void {
  if (!config || !clock || !config.enabled) return;

  const active = config;
  const hlc = clock.next();

  chain = chain
    .then(() => persist(event, hlc, active))
    .catch((error) => console.error('Could not record sync change', error));
}
