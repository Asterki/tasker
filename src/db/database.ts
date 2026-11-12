/**
 * IndexedDB persistence layer.
 *
 * Tasker is local-first: this module is the single source of truth for every
 * task, project, category, place and setting. There is no server-side database —
 * the app works fully offline. Sync metadata (outbox, versions, keys) lives in
 * separate stores so domain records stay clean.
 */

import type { Category, NotificationSettings, Place, Project, Settings, Tag, Task } from '../domain/types';
import { DEFAULT_NOTIFICATIONS, DEFAULT_SETTINGS } from '../domain/types';
import { deviceTimezone, isValidTimezone } from '../domain/date';

const DB_NAME = 'tasker';
/** v2 added `categories` and multi-day fields; v3 removed push; v4 added sync; v5 added ntfy reminders. */
const DB_VERSION = 5;

export const STORE = {
  tasks: 'tasks',
  categories: 'categories',
  projects: 'projects',
  places: 'places',
  settings: 'settings',
} as const;

export const SYNC_STORE = {
  outbox: 'sync_outbox',
  versions: 'sync_versions',
  state: 'sync_state',
} as const;

/** Device-local ledger of reminders published to ntfy. Never synced. */
export const NOTIFY_STORE = 'ntfy_scheduled';

export interface ScheduledReminderRecord {
  /** ntfy sequence id; also the IndexedDB key. */
  id: string;
  taskId: string;
  /** Absolute epoch ms the notification should fire. */
  remindAt: number;
  /** Content signature used to detect edits without republishing. */
  fingerprint: string;
  state: 'scheduled' | 'error';
  /** Target captured at publish time so topic/token changes can still cancel. */
  serverUrl: string;
  topic: string;
  token: string;
  updatedAt: number;
}

export type StoreName = (typeof STORE)[keyof typeof STORE];
export type EntityKind = 'task' | 'category' | 'project' | 'place' | 'settings';

const SETTINGS_KEY = 'app';

let dbPromise: Promise<IDBDatabase> | null = null;

export function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);

    open.onupgradeneeded = () => {
      const db = open.result;

      if (!db.objectStoreNames.contains(STORE.tasks)) {
        const tasks = db.createObjectStore(STORE.tasks, { keyPath: 'id' });
        tasks.createIndex('byDate', 'date');
        tasks.createIndex('byProject', 'projectId');
        tasks.createIndex('byCompleted', 'completed');
      }
      if (!db.objectStoreNames.contains(STORE.categories)) {
        db.createObjectStore(STORE.categories, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE.projects)) {
        db.createObjectStore(STORE.projects, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE.places)) {
        db.createObjectStore(STORE.places, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE.settings)) {
        db.createObjectStore(STORE.settings);
      }
      // v3: reminders are gone, so the push-subscription store is no longer needed.
      if (db.objectStoreNames.contains('subscriptions')) {
        db.deleteObjectStore('subscriptions');
      }
      if (!db.objectStoreNames.contains(SYNC_STORE.outbox)) {
        const outbox = db.createObjectStore(SYNC_STORE.outbox, { keyPath: 'changeId' });
        outbox.createIndex('byEntity', ['entityType', 'entityId']);
      }
      if (!db.objectStoreNames.contains(SYNC_STORE.versions)) {
        db.createObjectStore(SYNC_STORE.versions, { keyPath: ['entityType', 'entityId'] });
      }
      if (!db.objectStoreNames.contains(SYNC_STORE.state)) {
        db.createObjectStore(SYNC_STORE.state, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(NOTIFY_STORE)) {
        const notify = db.createObjectStore(NOTIFY_STORE, { keyPath: 'id' });
        notify.createIndex('byTask', 'taskId');
      }
    };

    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });

  return dbPromise;
}

async function readAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDatabase();
  const tx = db.transaction(store, 'readonly');
  return request(tx.objectStore(store).getAll() as IDBRequest<T[]>);
}

/* ── Mutation notifications ───────────────────────────────────────────────── */

export interface MutationEvent {
  store: StoreName;
  puts: unknown[];
  deletes: string[];
}

let mutationListener: ((event: MutationEvent) => void) | null = null;

/** Registered by the sync recorder; every domain write is mirrored to the outbox. */
export function setMutationListener(listener: ((event: MutationEvent) => void) | null): void {
  mutationListener = listener;
}

function emitMutation(event: MutationEvent): void {
  if (!mutationListener) return;
  try {
    mutationListener(event);
  } catch (error) {
    console.error('Mutation listener failed', error);
  }
}

async function putValue<T>(store: StoreName, value: T, key?: IDBValidKey): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value as unknown as object, key);
  await transactionDone(tx);
  emitMutation({ store, puts: [value], deletes: [] });
}

async function putValues<T>(store: StoreName, values: T[]): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(store, 'readwrite');
  const target = tx.objectStore(store);
  for (const value of values) target.put(value as unknown as object);
  await transactionDone(tx);
  emitMutation({ store, puts: values, deletes: [] });
}

async function deleteValue(store: StoreName, key: IDBValidKey): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await transactionDone(tx);
  emitMutation({ store, puts: [], deletes: [String(key)] });
}

async function clearStore(store: StoreName): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).clear();
  await transactionDone(tx);
}

/* ── Schema normalisation ─────────────────────────────────────────────────── */

/**
 * Fills in fields added after a record was written. Records are stored
 * verbatim, so older rows simply read back with the new fields defaulted.
 */
export function normalizeTask(task: Task): Task {
  return {
    id: task.id,
    title: task.title ?? 'Untitled task',
    notes: task.notes ?? '',
    projectId: task.projectId ?? null,
    parentId: task.parentId ?? null,
    place: task.place ?? null,
    priority: task.priority ?? 4,
    date: task.date ?? null,
    time: task.time ?? null,
    endDate: task.endDate ?? task.date ?? null,
    endTime: task.endTime ?? null,
    allDay: task.allDay ?? !task.time,
    tags: task.tags ?? [],
    lane: task.lane ?? '',
    recurrence: task.recurrence ?? null,
    reminder: task.reminder ?? true,
    completed: task.completed ?? false,
    completedAt: task.completedAt ?? null,
    seriesId: task.seriesId ?? task.id,
    order: task.order ?? 0,
    createdAt: task.createdAt ?? Date.now(),
    updatedAt: task.updatedAt ?? task.createdAt ?? Date.now(),
  };
}

export function normalizeProject(project: Project): Project {
  return {
    id: project.id,
    name: project.name ?? 'Project',
    color: project.color ?? '#58a6ff',
    categoryId: project.categoryId ?? null,
    tags: project.tags ?? [],
    order: project.order ?? 0,
    createdAt: project.createdAt ?? Date.now(),
  };
}

export function normalizeSettings(stored: Partial<Settings> | null | undefined): Settings {
  const value = stored ?? {};
  const notifications = (value.notifications ?? {}) as Partial<NotificationSettings>;
  const allDayCount = Number(notifications.allDayCount);

  return {
    theme:
      value.theme === 'nordic-dark' || value.theme === 'nordic-light'
        ? value.theme
        : DEFAULT_SETTINGS.theme,
    defaultProjectId: value.defaultProjectId ?? null,
    progress: { ...DEFAULT_SETTINGS.progress, ...(value.progress ?? {}) },
    soundEnabled: value.soundEnabled ?? false,
    hapticsEnabled: value.hapticsEnabled ?? true,
    timezone:
      typeof value.timezone === 'string' && isValidTimezone(value.timezone)
        ? value.timezone
        : deviceTimezone(),
    notifications: {
      enabled: notifications.enabled ?? DEFAULT_NOTIFICATIONS.enabled,
      serverUrl:
        typeof notifications.serverUrl === 'string' && notifications.serverUrl.trim()
          ? notifications.serverUrl.trim()
          : DEFAULT_NOTIFICATIONS.serverUrl,
      topic: typeof notifications.topic === 'string' ? notifications.topic.trim() : '',
      token: typeof notifications.token === 'string' ? notifications.token.trim() : '',
      allDayCount: Number.isFinite(allDayCount)
        ? Math.min(5, Math.max(1, Math.round(allDayCount)))
        : DEFAULT_NOTIFICATIONS.allDayCount,
    },
  };
}

export interface DatabaseSnapshot {
  tasks: Task[];
  categories: Category[];
  projects: Project[];
  places: Place[];
  settings: Settings;
}

/** Loads the complete application state in one shot (used on boot). */
export async function loadSnapshot(): Promise<DatabaseSnapshot> {
  const db = await openDatabase();
  const tx = db.transaction([STORE.tasks, STORE.categories, STORE.projects, STORE.places, STORE.settings], 'readonly');

  const [tasks, categories, projects, places, settings] = await Promise.all([
    request(tx.objectStore(STORE.tasks).getAll() as IDBRequest<Task[]>),
    request(tx.objectStore(STORE.categories).getAll() as IDBRequest<Category[]>),
    request(tx.objectStore(STORE.projects).getAll() as IDBRequest<Project[]>),
    request(tx.objectStore(STORE.places).getAll() as IDBRequest<Place[]>),
    request(tx.objectStore(STORE.settings).get(SETTINGS_KEY) as IDBRequest<Settings | undefined>),
  ]);

  return {
    tasks: tasks.map(normalizeTask),
    categories: categories.sort((a, b) => a.order - b.order),
    projects: projects.map(normalizeProject).sort((a, b) => a.order - b.order),
    places,
    settings: normalizeSettings(settings),
  };
}

export const db = {
  tasks: {
    all: () => readAll<Task>(STORE.tasks),
    put: (task: Task) => putValue(STORE.tasks, task),
    putMany: (tasks: Task[]) => putValues(STORE.tasks, tasks),
    remove: (id: string) => deleteValue(STORE.tasks, id),
    removeMany: async (ids: string[]) => {
      const database = await openDatabase();
      const tx = database.transaction(STORE.tasks, 'readwrite');
      const store = tx.objectStore(STORE.tasks);
      for (const id of ids) store.delete(id);
      await transactionDone(tx);
      emitMutation({ store: STORE.tasks, puts: [], deletes: ids });
    },
    clear: () => clearStore(STORE.tasks),
  },
  categories: {
    all: () => readAll<Category>(STORE.categories),
    put: (category: Category) => putValue(STORE.categories, category),
    putMany: (categories: Category[]) => putValues(STORE.categories, categories),
    remove: (id: string) => deleteValue(STORE.categories, id),
    clear: () => clearStore(STORE.categories),
  },
  projects: {
    all: () => readAll<Project>(STORE.projects),
    put: (project: Project) => putValue(STORE.projects, project),
    putMany: (projects: Project[]) => putValues(STORE.projects, projects),
    remove: (id: string) => deleteValue(STORE.projects, id),
    clear: () => clearStore(STORE.projects),
  },
  places: {
    all: () => readAll<Place>(STORE.places),
    put: (place: Place) => putValue(STORE.places, place),
    putMany: (places: Place[]) => putValues(STORE.places, places),
    remove: (id: string) => deleteValue(STORE.places, id),
    clear: () => clearStore(STORE.places),
  },
  settings: {
    async get(): Promise<Settings> {
      const database = await openDatabase();
      const tx = database.transaction(STORE.settings, 'readonly');
      const value = await request(tx.objectStore(STORE.settings).get(SETTINGS_KEY) as IDBRequest<Settings | undefined>);
      return normalizeSettings(value);
    },
    put: (settings: Settings) => putValue(STORE.settings, settings, SETTINGS_KEY),
    clear: () => clearStore(STORE.settings),
  },
};

/**
 * Reminder ledger. Deliberately bypasses `emitMutation`: scheduled messages are
 * a per-device delivery detail, not domain data that should sync.
 */
export const scheduledReminders = {
  async all(): Promise<ScheduledReminderRecord[]> {
    const database = await openDatabase();
    const tx = database.transaction(NOTIFY_STORE, 'readonly');
    return request(tx.objectStore(NOTIFY_STORE).getAll() as IDBRequest<ScheduledReminderRecord[]>);
  },
  async put(record: ScheduledReminderRecord): Promise<void> {
    const database = await openDatabase();
    const tx = database.transaction(NOTIFY_STORE, 'readwrite');
    tx.objectStore(NOTIFY_STORE).put(record);
    await transactionDone(tx);
  },
  async remove(id: string): Promise<void> {
    const database = await openDatabase();
    const tx = database.transaction(NOTIFY_STORE, 'readwrite');
    tx.objectStore(NOTIFY_STORE).delete(id);
    await transactionDone(tx);
  },
};

/** Wipes every domain store — used by the "Reset app" action. */
export async function clearAll(): Promise<void> {
  await Promise.all([
    db.tasks.clear(),
    db.categories.clear(),
    db.projects.clear(),
    db.places.clear(),
    db.settings.clear(),
  ]);
}

/* ── Sync metadata ────────────────────────────────────────────────────────── */

export interface OutboxRecord<T = unknown> {
  changeId: string;
  entityType: EntityKind;
  entityId: string;
  hlc: string;
  deleted: boolean;
  payload: T;
}

export interface VersionRecord {
  entityType: EntityKind;
  entityId: string;
  hlc: string;
  deleted: boolean;
}

export function entityStore(kind: EntityKind): StoreName {
  if (kind === 'task') return STORE.tasks;
  if (kind === 'category') return STORE.categories;
  if (kind === 'project') return STORE.projects;
  if (kind === 'place') return STORE.places;
  return STORE.settings;
}

export async function getVersion(kind: EntityKind, id: string): Promise<VersionRecord | undefined> {
  const database = await openDatabase();
  const tx = database.transaction(SYNC_STORE.versions, 'readonly');
  return request(
    tx.objectStore(SYNC_STORE.versions).get([kind, id]) as IDBRequest<VersionRecord | undefined>,
  );
}

export async function putVersion(version: VersionRecord): Promise<void> {
  const database = await openDatabase();
  const tx = database.transaction(SYNC_STORE.versions, 'readwrite');
  tx.objectStore(SYNC_STORE.versions).put(version);
  await transactionDone(tx);
}

export async function listOutbox<T = unknown>(): Promise<OutboxRecord<T>[]> {
  const database = await openDatabase();
  const tx = database.transaction(SYNC_STORE.outbox, 'readonly');
  return request(tx.objectStore(SYNC_STORE.outbox).getAll() as IDBRequest<OutboxRecord<T>[]>);
}

export async function putOutbox(record: OutboxRecord): Promise<void> {
  const database = await openDatabase();
  const tx = database.transaction(SYNC_STORE.outbox, 'readwrite');
  tx.objectStore(SYNC_STORE.outbox).put(record);
  await transactionDone(tx);
}

export async function removeOutbox(changeIds: string[]): Promise<void> {
  if (changeIds.length === 0) return;
  const database = await openDatabase();
  const tx = database.transaction(SYNC_STORE.outbox, 'readwrite');
  const store = tx.objectStore(SYNC_STORE.outbox);
  for (const id of changeIds) store.delete(id);
  await transactionDone(tx);
}

export async function clearOutboxForEntity(kind: EntityKind, id: string): Promise<void> {
  const database = await openDatabase();
  const tx = database.transaction(SYNC_STORE.outbox, 'readwrite');
  const store = tx.objectStore(SYNC_STORE.outbox);
  const index = store.index('byEntity');
  const cursor = await request(index.openCursor([kind, id]));
  if (cursor) cursor.delete();
  await transactionDone(tx);
}

export async function readSyncState<T>(key: string): Promise<T | undefined> {
  const database = await openDatabase();
  const tx = database.transaction(SYNC_STORE.state, 'readonly');
  const row = await request(
    tx.objectStore(SYNC_STORE.state).get(key) as IDBRequest<{ key: string; value: T } | undefined>,
  );
  return row?.value;
}

export async function writeSyncState<T>(key: string, value: T): Promise<void> {
  const database = await openDatabase();
  const tx = database.transaction(SYNC_STORE.state, 'readwrite');
  tx.objectStore(SYNC_STORE.state).put({ key, value });
  await transactionDone(tx);
}

export async function deleteSyncState(key: string): Promise<void> {
  const database = await openDatabase();
  const tx = database.transaction(SYNC_STORE.state, 'readwrite');
  tx.objectStore(SYNC_STORE.state).delete(key);
  await transactionDone(tx);
}

export async function clearSyncStores(): Promise<void> {
  const database = await openDatabase();
  const tx = database.transaction(
    [SYNC_STORE.outbox, SYNC_STORE.versions, SYNC_STORE.state],
    'readwrite',
  );
  tx.objectStore(SYNC_STORE.outbox).clear();
  tx.objectStore(SYNC_STORE.versions).clear();
  tx.objectStore(SYNC_STORE.state).clear();
  await transactionDone(tx);
}

/** Reads one entity for the merge engine. */
export async function readEntity<T>(kind: EntityKind, id: string): Promise<T | undefined> {
  const database = await openDatabase();
  const store = entityStore(kind);
  const tx = database.transaction(store, 'readonly');
  const key = kind === 'settings' ? SETTINGS_KEY : id;
  return request(tx.objectStore(store).get(key) as IDBRequest<T | undefined>);
}

/** Writes a remote entity without echoing it back into the outbox. */
export async function writeEntitySilently(kind: EntityKind, value: unknown): Promise<void> {
  const database = await openDatabase();
  const store = entityStore(kind);
  const tx = database.transaction(store, 'readwrite');
  tx.objectStore(store).put(value as object, kind === 'settings' ? SETTINGS_KEY : undefined);
  await transactionDone(tx);
}

/** Removes a remote entity without recording a tombstone. */
export async function deleteEntitySilently(kind: EntityKind, id: string): Promise<void> {
  const database = await openDatabase();
  const store = entityStore(kind);
  const tx = database.transaction(store, 'readwrite');
  tx.objectStore(store).delete(kind === 'settings' ? SETTINGS_KEY : id);
  await transactionDone(tx);
}

/* ── UUID migration ───────────────────────────────────────────────────────── */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_NAMESPACE = [
  0x6b, 0xa7, 0xb8, 0x81, 0x9d, 0xad, 0x11, 0xd9, 0x9a, 0x3b, 0x00, 0x50, 0x56, 0xc2, 0x00, 0x07,
];
const encoder = new TextEncoder();

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

async function uuidFor(kind: string, id: string): Promise<string> {
  const name = encoder.encode(`${kind}:${id}`);
  const bytes = new Uint8Array(UUID_NAMESPACE.length + name.length);
  bytes.set(UUID_NAMESPACE);
  bytes.set(name, UUID_NAMESPACE.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes)).slice(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Rewrites legacy `tsk_…` identifiers to deterministic UUIDs so devices that
 * already shared data converge instead of duplicating it. Idempotent.
 */
export async function ensureUuids(): Promise<void> {
  const marker = await readSyncState<{ done: boolean }>('migration');
  if (marker?.done) return;

  const database = await openDatabase();
  const readTx = database.transaction(
    [STORE.tasks, STORE.categories, STORE.projects, STORE.places, STORE.settings],
    'readonly',
  );
  const [tasks, categories, projects, places, settings] = await Promise.all([
    request(readTx.objectStore(STORE.tasks).getAll() as IDBRequest<Task[]>),
    request(readTx.objectStore(STORE.categories).getAll() as IDBRequest<Category[]>),
    request(readTx.objectStore(STORE.projects).getAll() as IDBRequest<Project[]>),
    request(readTx.objectStore(STORE.places).getAll() as IDBRequest<Place[]>),
    request(readTx.objectStore(STORE.settings).get(SETTINGS_KEY) as IDBRequest<Settings | undefined>),
  ]);

  const categoryIds = new Map<string, string>();
  const projectIds = new Map<string, string>();
  const taskIds = new Map<string, string>();
  const seriesIds = new Map<string, string>();
  const tagIds = new Map<string, string>();

  for (const category of categories) {
    if (!isUuid(category.id)) categoryIds.set(category.id, await uuidFor('category', category.id));
  }
  for (const project of projects) {
    if (!isUuid(project.id)) projectIds.set(project.id, await uuidFor('project', project.id));
    for (const tag of project.tags ?? []) {
      if (!isUuid(tag.id)) tagIds.set(tag.id, await uuidFor('tag', tag.id));
    }
  }
  for (const task of tasks) {
    if (!isUuid(task.id)) taskIds.set(task.id, await uuidFor('task', task.id));
    if (!isUuid(task.seriesId)) {
      seriesIds.set(task.seriesId, await uuidFor('series', task.seriesId));
    }
  }

  const mapId = (map: Map<string, string>, id: string | null): string | null =>
    id === null ? null : map.get(id) ?? (isUuid(id) ? id : null);

  const nextCategories = categories.map((category) => ({
    ...category,
    id: categoryIds.get(category.id) ?? category.id,
  }));

  const nextProjects = projects.map((project) => ({
    ...project,
    id: projectIds.get(project.id) ?? project.id,
    categoryId: mapId(categoryIds, project.categoryId),
    tags: (project.tags ?? []).map((tag: Tag) => ({
      ...tag,
      id: tagIds.get(tag.id) ?? tag.id,
    })),
  }));

  const nextTasks = tasks.map((task) => ({
    ...task,
    id: taskIds.get(task.id) ?? task.id,
    projectId: mapId(projectIds, task.projectId),
    parentId: mapId(taskIds, task.parentId),
    seriesId: seriesIds.get(task.seriesId) ?? task.seriesId,
  }));

  const nextSettings = settings
    ? { ...settings, defaultProjectId: mapId(projectIds, settings.defaultProjectId ?? null) }
    : undefined;

  const placeIds = new Map<string, string>();
  for (const place of places) {
    if (!isUuid(place.id)) placeIds.set(place.id, await uuidFor('place', place.id));
  }

  const writeTx = database.transaction(
    [
      STORE.tasks,
      STORE.categories,
      STORE.projects,
      STORE.places,
      STORE.settings,
      SYNC_STORE.state,
    ],
    'readwrite',
  );

  const taskStore = writeTx.objectStore(STORE.tasks);
  for (const task of tasks) taskStore.delete(task.id);
  for (const task of nextTasks) taskStore.put(task);

  const categoryStore = writeTx.objectStore(STORE.categories);
  for (const category of categories) categoryStore.delete(category.id);
  for (const category of nextCategories) categoryStore.put(category);

  const projectStore = writeTx.objectStore(STORE.projects);
  for (const project of projects) projectStore.delete(project.id);
  for (const project of nextProjects) projectStore.put(project);

  const placeStore = writeTx.objectStore(STORE.places);
  for (const place of places) {
    const nextId = placeIds.get(place.id);
    if (nextId) {
      placeStore.delete(place.id);
      placeStore.put({ ...place, id: nextId });
    }
  }

  if (nextSettings) writeTx.objectStore(STORE.settings).put(nextSettings, SETTINGS_KEY);

  writeTx.objectStore(SYNC_STORE.state).put({ key: 'migration', value: { done: true } });
  await transactionDone(writeTx);
}

/** Re-runs the UUID migration after importing an older backup. */
export async function resetUuidMigration(): Promise<void> {
  await deleteSyncState('migration');
}

/** Generates a collision-resistant id without pulling in a uuid dependency. */
export function createId(_prefix = 'id'): string {
  // Every entity gets a real UUID so two devices can never mint the same id.
  return crypto.randomUUID();
}
