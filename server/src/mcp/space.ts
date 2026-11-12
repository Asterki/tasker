/**
 * Encrypted-space access for MCP tools.
 *
 * The MCP peer behaves like another sync device: it reads the relay snapshot,
 * decrypts payloads with the passphrase-derived key, and writes encrypted
 * changes with a monotonic HLC so every real device merges them normally.
 */

import { randomUUID } from 'node:crypto';
import { currentHead, pushChanges, snapshot, type EntityType, type UserRow } from '../db.js';
import { decryptPayload, encryptPayload, type SyncKeys } from './crypto.js';
import { HlcClock } from './hlc.js';
import type {
  CategoryRecord,
  PlaceRecord,
  Priority,
  ProjectRecord,
  RecurrenceRule,
  SyncEntity,
  TaskRecord,
} from './types.js';

const MCP_CLIENT_ID = `mcp-${randomUUID()}`;
const clocks = new Map<string, HlcClock>();

export interface Space {
  user: UserRow;
  keys: SyncKeys;
  clientId: string;
  clock: HlcClock;
  entities: Map<string, SyncEntity>;
  tasks: TaskRecord[];
  projects: ProjectRecord[];
  categories: CategoryRecord[];
  places: PlaceRecord[];
  settings: Record<string, unknown> | null;
}

export interface TaskView extends TaskRecord {
  projectName: string | null;
  categoryName: string | null;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asPriority(value: unknown): Priority {
  return value === 1 || value === 2 || value === 3 ? value : 4;
}

function normalizeRecurrence(value: unknown): RecurrenceRule | null {
  if (!value || typeof value !== 'object') return null;
  const rule = value as Partial<RecurrenceRule>;
  if (!rule.freq) return null;
  return {
    freq: rule.freq,
    interval: typeof rule.interval === 'number' ? rule.interval : 1,
    byWeekday: Array.isArray(rule.byWeekday) ? rule.byWeekday : [],
    byMonthDay: Array.isArray(rule.byMonthDay) ? rule.byMonthDay : [],
    until: asNullableString(rule.until),
    count: typeof rule.count === 'number' ? rule.count : null,
  };
}

export function normalizeTask(value: unknown): TaskRecord | null {
  if (!value || typeof value !== 'object') return null;
  const task = value as Partial<TaskRecord>;
  if (!task.id) return null;
  const date = asNullableString(task.date);
  const time = asNullableString(task.time);
  return {
    id: task.id,
    title: asString(task.title, 'Untitled task'),
    notes: asString(task.notes),
    projectId: asNullableString(task.projectId),
    parentId: asNullableString(task.parentId),
    place: asNullableString(task.place),
    priority: asPriority(task.priority),
    date,
    time,
    endDate: asNullableString(task.endDate) ?? date,
    endTime: asNullableString(task.endTime),
    allDay: task.allDay ?? !time,
    tags: Array.isArray(task.tags) ? task.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    lane: asString(task.lane),
    recurrence: normalizeRecurrence(task.recurrence),
    reminder: task.reminder ?? true,
    completed: task.completed ?? false,
    completedAt: typeof task.completedAt === 'number' ? task.completedAt : null,
    seriesId: asString(task.seriesId, task.id),
    order: typeof task.order === 'number' ? task.order : 0,
    createdAt: typeof task.createdAt === 'number' ? task.createdAt : Date.now(),
    updatedAt: typeof task.updatedAt === 'number' ? task.updatedAt : Date.now(),
  };
}

function normalizeProject(value: unknown): ProjectRecord | null {
  if (!value || typeof value !== 'object') return null;
  const project = value as Partial<ProjectRecord>;
  if (!project.id) return null;
  return {
    id: project.id,
    name: asString(project.name, 'Project'),
    color: asString(project.color, '#58a6ff'),
    categoryId: asNullableString(project.categoryId),
    tags: Array.isArray(project.tags) ? project.tags : [],
    order: typeof project.order === 'number' ? project.order : 0,
    createdAt: typeof project.createdAt === 'number' ? project.createdAt : Date.now(),
  };
}

function normalizeCategory(value: unknown): CategoryRecord | null {
  if (!value || typeof value !== 'object') return null;
  const category = value as Partial<CategoryRecord>;
  if (!category.id) return null;
  return {
    id: category.id,
    name: asString(category.name, 'Category'),
    color: asString(category.color, '#58a6ff'),
    order: typeof category.order === 'number' ? category.order : 0,
    createdAt: typeof category.createdAt === 'number' ? category.createdAt : Date.now(),
  };
}

function normalizePlace(value: unknown): PlaceRecord | null {
  if (!value || typeof value !== 'object') return null;
  const place = value as Partial<PlaceRecord>;
  if (!place.id) return null;
  return {
    id: place.id,
    name: asString(place.name),
    createdAt: typeof place.createdAt === 'number' ? place.createdAt : Date.now(),
  };
}

/** Pulls the whole snapshot and decrypts every live entity. */
export async function loadSpace(user: UserRow, keys: SyncKeys): Promise<Space> {
  const clock =
    clocks.get(user.key_hash) ?? new HlcClock(MCP_CLIENT_ID);
  clocks.set(user.key_hash, clock);

  const entities = new Map<string, SyncEntity>();
  const head = currentHead(user.key_hash);
  let after: { type: string; id: string } | null = null;

  for (;;) {
    const page = snapshot(user.key_hash, head, after, 200);
    for (const entity of page.entities) {
      clock.observe(entity.hlc);
      if (entity.deleted) continue;
      let value: unknown;
      try {
        value = await decryptPayload(entity.payload, keys.encKey);
      } catch {
        throw new Error(
          'The sync payload could not be decrypted. Check that the MCP passphrase matches the sync space.',
        );
      }
      entities.set(`${entity.entity_type}:${entity.entity_id}`, {
        entityType: entity.entity_type,
        entityId: entity.entity_id,
        hlc: entity.hlc,
        value,
      });
    }
    if (!page.next) break;
    after = page.next;
  }

  const tasks: TaskRecord[] = [];
  const projects: ProjectRecord[] = [];
  const categories: CategoryRecord[] = [];
  const places: PlaceRecord[] = [];
  let settings: Record<string, unknown> | null = null;

  for (const entity of entities.values()) {
    const value = entity.value;
    if (entity.entityType === 'task') {
      const task = normalizeTask(value);
      if (task) tasks.push(task);
    } else if (entity.entityType === 'project') {
      const project = normalizeProject(value);
      if (project) projects.push(project);
    } else if (entity.entityType === 'category') {
      const category = normalizeCategory(value);
      if (category) categories.push(category);
    } else if (entity.entityType === 'place') {
      const place = normalizePlace(value);
      if (place) places.push(place);
    } else if (entity.entityType === 'settings') {
      settings = (value as Record<string, unknown>) ?? null;
    }
  }

  tasks.sort((a, b) => a.order - b.order);
  projects.sort((a, b) => a.order - b.order);
  categories.sort((a, b) => a.order - b.order);

  return {
    user,
    keys,
    clientId: MCP_CLIENT_ID,
    clock,
    entities,
    tasks,
    projects,
    categories,
    places,
    settings,
  };
}

/** Encrypts and appends one entity change. Returns the new HLC. */
export async function writeEntity(
  space: Space,
  entityType: EntityType,
  entityId: string,
  value: unknown,
  deleted = false,
): Promise<string> {
  const hlc = space.clock.next();
  const payload = deleted ? '' : await encryptPayload(value, space.keys.encKey);

  pushChanges(space.user.key_hash, [
    {
      changeId: randomUUID(),
      clientId: MCP_CLIENT_ID,
      entityType,
      entityId,
      hlc,
      deleted,
      payload,
    },
  ]);
  return hlc;
}

export function toTaskView(space: Space, task: TaskRecord): TaskView {
  const project = task.projectId
    ? space.projects.find((item) => item.id === task.projectId) ?? null
    : null;
  const category = project?.categoryId
    ? space.categories.find((item) => item.id === project.categoryId) ?? null
    : null;

  return {
    ...task,
    projectName: project?.name ?? null,
    categoryName: category?.name ?? null,
  };
}

export function findProject(space: Space, reference?: string | null): ProjectRecord | null {
  if (!reference) return null;
  const needle = reference.trim().toLowerCase();
  return (
    space.projects.find(
      (project) => project.id === reference || project.name.toLowerCase() === needle,
    ) ?? null
  );
}

export function findCategory(space: Space, reference?: string | null): CategoryRecord | null {
  if (!reference) return null;
  const needle = reference.trim().toLowerCase();
  return (
    space.categories.find(
      (category) => category.id === reference || category.name.toLowerCase() === needle,
    ) ?? null
  );
}

export function descendantIds(tasks: TaskRecord[], id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  let frontier = [id];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const parentId of frontier) {
      for (const task of tasks) {
        if (task.parentId === parentId && !seen.has(task.id)) {
          seen.add(task.id);
          out.push(task.id);
          next.push(task.id);
        }
      }
    }
    frontier = next;
  }
  return out;
}

export function nextOrder(items: { order: number }[]): number {
  return items.reduce((max, item) => Math.max(max, item.order), 0) + 1;
}
