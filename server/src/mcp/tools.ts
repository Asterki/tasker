/**
 * MCP tools exposed to a model.
 *
 * Read tools work from the decrypted sync snapshot. Write tools append encrypted
 * changes with a fresh HLC, so the browser and every other device merge them on
 * their next sync cycle.
 */

import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { UserRow } from '../db.js';
import {
  createRecurrence,
  isExhausted,
  isValidISODate,
  isValidTime,
  nextOccurrence,
  shiftRange,
} from './dates.js';
import {
  descendantIds,
  findCategory,
  findProject,
  loadSpace,
  nextOrder,
  toTaskView,
  writeEntity,
  type Space,
  type TaskView,
} from './space.js';
import type { CategoryRecord, Priority, ProjectRecord, RecurrenceRule, TaskRecord } from './types.js';
import type { SyncKeys } from './crypto.js';

export interface McpContext {
  user: UserRow;
  keys: SyncKeys;
}

const PROJECT_COLORS = [
  '#58a6ff', '#3fb950', '#d29922', '#f85149', '#bc8cff',
  '#39c5cf', '#db61a2', '#8b949e', '#a5d6ff', '#ffa657',
];

const dateSchema = z
  .string()
  .refine((value) => isValidISODate(value), 'Expected a valid date in YYYY-MM-DD format.');

const timeSchema = z
  .string()
  .refine((value) => isValidTime(value), 'Expected a 24-hour time in HH:mm format.');

const recurrenceSchema = z.object({
  freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().min(1).max(365).optional(),
  byWeekday: z.array(z.number().int().min(0).max(6)).optional(),
  byMonthDay: z.array(z.number().int().min(1).max(31)).optional(),
  until: dateSchema.nullable().optional(),
  count: z.number().int().min(1).nullable().optional(),
});

const statusSchema = z.enum(['open', 'completed', 'all']);

interface ToolResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function ok(value: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  };
}

function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function todayIn(space: Space): string {
  const zone = typeof space.settings?.timezone === 'string' ? space.settings.timezone : 'UTC';
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function compareDue(a: TaskRecord, b: TaskRecord): number {
  const aDate = a.date ?? '9999-12-31';
  const bDate = b.date ?? '9999-12-31';
  if (aDate !== bDate) return aDate < bDate ? -1 : 1;
  const aTime = a.time ?? '99:99';
  const bTime = b.time ?? '99:99';
  if (aTime !== bTime) return aTime < bTime ? -1 : 1;
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.order - b.order;
}

interface FilterInput {
  status?: 'open' | 'completed' | 'all';
  project?: string;
  category?: string;
  place?: string;
  priority?: number;
  query?: string;
  from?: string;
  to?: string;
  limit?: number;
}

function filterTasks(space: Space, input: FilterInput): TaskView[] {
  const status = input.status ?? 'open';
  let project: ProjectRecord | null = null;
  let category: CategoryRecord | null = null;

  if (input.project) {
    project = findProject(space, input.project);
    if (!project) {
      const names = space.projects.map((item) => item.name).join(', ') || 'none';
      throw new Error(`Project "${input.project}" was not found. Projects: ${names}.`);
    }
  }
  if (input.category) {
    category = findCategory(space, input.category);
    if (!category) {
      const names = space.categories.map((item) => item.name).join(', ') || 'none';
      throw new Error(`Category "${input.category}" was not found. Categories: ${names}.`);
    }
  }

  const query = input.query?.trim().toLowerCase();
  const filtered = space.tasks.filter((task) => {
    if (status === 'open' && task.completed) return false;
    if (status === 'completed' && !task.completed) return false;
    if (project && task.projectId !== project.id) return false;
    if (category) {
      const owner = space.projects.find((item) => item.id === task.projectId);
      if (owner?.categoryId !== category.id) return false;
    }
    if (input.place && (task.place ?? '').toLowerCase() !== input.place.toLowerCase()) return false;
    if (input.priority && task.priority !== input.priority) return false;
    if (input.from && (!task.date || task.date < input.from)) return false;
    if (input.to && (!task.date || task.date > input.to)) return false;
    if (query) {
      const haystack = `${task.title}\n${task.notes}\n${task.tags.join(' ')}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  filtered.sort((a, b) => (status === 'completed' ? (b.completedAt ?? 0) - (a.completedAt ?? 0) : compareDue(a, b)));
  return filtered.slice(0, limit).map((task) => toTaskView(space, task));
}

function describeProject(space: Space, project: ProjectRecord) {
  return {
    ...project,
    categoryName: project.categoryId
      ? space.categories.find((item) => item.id === project.categoryId)?.name ?? null
      : null,
    openTasks: space.tasks.filter((task) => task.projectId === project.id && !task.completed).length,
    completedTasks: space.tasks.filter((task) => task.projectId === project.id && task.completed).length,
  };
}

function normalizeRuleInput(
  repeat: 'daily' | 'weekly' | 'monthly' | 'yearly' | undefined,
  recurrence: z.infer<typeof recurrenceSchema> | undefined,
  dateISO: string | null,
): RecurrenceRule | null {
  if (recurrence) {
    return {
      freq: recurrence.freq,
      interval: recurrence.interval ?? 1,
      byWeekday: recurrence.byWeekday ?? [],
      byMonthDay: recurrence.byMonthDay ?? [],
      until: recurrence.until ?? null,
      count: recurrence.count ?? null,
    };
  }
  if (repeat && dateISO) return createRecurrence(repeat, dateISO);
  return null;
}

export function registerTaskerTools(server: McpServer, context: McpContext): void {
  let cached: Promise<Space> | null = null;
  const space = () => (cached ??= loadSpace(context.user, context.keys));
  const invalidate = () => {
    cached = null;
  };

  server.registerTool(
    'list_tasks',
    {
      title: 'List tasks',
      description:
        'List tasks from Tasker, filtered by status, project, category, place, priority, date range or text. Returns up to 200 tasks.',
      inputSchema: {
        status: statusSchema.optional().describe('open (default), completed or all'),
        project: z.string().optional().describe('Project name or id'),
        category: z.string().optional().describe('Category name or id'),
        place: z.string().optional().describe('Place/context name without @'),
        priority: z.number().int().min(1).max(4).optional(),
        query: z.string().optional().describe('Case-insensitive text in title, notes or tags'),
        from: dateSchema.optional().describe('Earliest task date (YYYY-MM-DD)'),
        to: dateSchema.optional().describe('Latest task date (YYYY-MM-DD)'),
        limit: z.number().int().min(1).max(200).optional().describe('Default 50, maximum 200'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const snapshot = await space();
        const tasks = filterTasks(snapshot, args);
        return ok({ count: tasks.length, tasks });
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Could not list tasks.');
      }
    },
  );

  server.registerTool(
    'get_task',
    {
      title: 'Get task',
      description: 'Fetch one task by id, including its subtasks.',
      inputSchema: {
        id: z.string().describe('Task UUID'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const snapshot = await space();
      const task = snapshot.tasks.find((item) => item.id === id);
      if (!task) return fail(`Task ${id} was not found.`);
      const children = descendantIds(snapshot.tasks, id)
        .map((childId) => snapshot.tasks.find((item) => item.id === childId))
        .filter((item): item is TaskRecord => Boolean(item))
        .map((item) => toTaskView(snapshot, item));
      return ok({ task: toTaskView(snapshot, task), subtasks: children });
    },
  );

  server.registerTool(
    'search_tasks',
    {
      title: 'Search tasks',
      description: 'Search task titles, notes and tags. Open tasks are searched by default.',
      inputSchema: {
        query: z.string().min(1),
        status: statusSchema.optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, status, limit }) => {
      try {
        const snapshot = await space();
        const tasks = filterTasks(snapshot, { query, status, limit });
        return ok({ count: tasks.length, tasks });
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Could not search tasks.');
      }
    },
  );

  server.registerTool(
    'task_overview',
    {
      title: 'Task overview',
      description: 'Counts of open, overdue, today, upcoming, undated and completed tasks, plus priorities.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const snapshot = await space();
      const today = todayIn(snapshot);
      const inSeven = new Date(`${today}T00:00:00Z`);
      inSeven.setUTCDate(inSeven.getUTCDate() + 7);
      const week = inSeven.toISOString().slice(0, 10);
      const open = snapshot.tasks.filter((task) => !task.completed);

      return ok({
        today,
        open: open.length,
        completed: snapshot.tasks.length - open.length,
        overdue: open.filter((task) => task.date && task.date < today).length,
        dueToday: open.filter((task) => task.date === today).length,
        upcoming: open.filter((task) => task.date && task.date > today && task.date <= week).length,
        undated: open.filter((task) => !task.date).length,
        byPriority: [1, 2, 3, 4].map((priority) => ({
          priority,
          open: open.filter((task) => task.priority === priority).length,
        })),
        projects: snapshot.projects.map((project) => ({
          id: project.id,
          name: project.name,
          open: open.filter((task) => task.projectId === project.id).length,
        })),
      });
    },
  );

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description: 'List projects with their category, tags and open/completed task counts.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const snapshot = await space();
      return ok({
        projects: snapshot.projects.map((project) => describeProject(snapshot, project)),
      });
    },
  );

  server.registerTool(
    'list_categories',
    {
      title: 'List categories',
      description: 'List categories and the projects they contain.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const snapshot = await space();
      return ok({
        categories: snapshot.categories.map((category) => ({
          ...category,
          projects: snapshot.projects
            .filter((project) => project.categoryId === category.id)
            .map((project) => ({ id: project.id, name: project.name })),
        })),
      });
    },
  );

  server.registerTool(
    'list_places',
    {
      title: 'List places',
      description: 'List known places/contexts and how many tasks use each.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const snapshot = await space();
      return ok({
        places: snapshot.places.map((place) => ({
          ...place,
          openTasks: snapshot.tasks.filter(
            (task) => !task.completed && (task.place ?? '').toLowerCase() === place.name.toLowerCase(),
          ).length,
        })),
      });
    },
  );

  server.registerTool(
    'create_project',
    {
      title: 'Create project',
      description: 'Create a Tasker project, optionally inside an existing category.',
      inputSchema: {
        name: z.string().min(1).max(120),
        category: z.string().optional().describe('Category name or id'),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      },
      annotations: { destructiveHint: false },
    },
    async ({ name, category, color }) => {
      try {
        const snapshot = await space();
        if (findProject(snapshot, name)) return fail(`A project named "${name}" already exists.`);
        const owner = category ? findCategory(snapshot, category) : null;
        if (category && !owner) return fail(`Category "${category}" was not found.`);

        const project: ProjectRecord = {
          id: randomUUID(),
          name: name.trim(),
          color: color ?? PROJECT_COLORS[snapshot.projects.length % PROJECT_COLORS.length],
          categoryId: owner?.id ?? null,
          tags: [],
          order: nextOrder(snapshot.projects),
          createdAt: Date.now(),
        };
        await writeEntity(snapshot, 'project', project.id, project);
        invalidate();
        return ok({ project: describeProject(snapshot, project) });
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Could not create the project.');
      }
    },
  );

  server.registerTool(
    'create_category',
    {
      title: 'Create category',
      description: 'Create a top-level Tasker category.',
      inputSchema: {
        name: z.string().min(1).max(120),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      },
    },
    async ({ name, color }) => {
      try {
        const snapshot = await space();
        if (findCategory(snapshot, name)) return fail(`A category named "${name}" already exists.`);
        const category: CategoryRecord = {
          id: randomUUID(),
          name: name.trim(),
          color: color ?? PROJECT_COLORS[snapshot.categories.length % PROJECT_COLORS.length],
          order: nextOrder(snapshot.categories),
          createdAt: Date.now(),
        };
        await writeEntity(snapshot, 'category', category.id, category);
        invalidate();
        return ok({ category });
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Could not create the category.');
      }
    },
  );

  server.registerTool(
    'create_task',
    {
      title: 'Create task',
      description:
        'Create a task. Dates are calendar days (YYYY-MM-DD); times are 24-hour HH:mm. If no time is given the task is all-day. Use a parent id to create a subtask.',
      inputSchema: {
        title: z.string().min(1).max(500),
        notes: z.string().optional(),
        project: z.string().optional().describe('Project name or id'),
        parent: z.string().optional().describe('Parent task id for a subtask'),
        place: z.string().optional().describe('Place/context without @'),
        priority: z.number().int().min(1).max(4).optional(),
        date: dateSchema.optional(),
        time: timeSchema.optional(),
        endDate: dateSchema.optional(),
        endTime: timeSchema.optional(),
        allDay: z.boolean().optional(),
        tags: z.array(z.string()).optional(),
        lane: z.string().optional(),
        reminder: z.boolean().optional().describe('Default true'),
        repeat: z.enum(['daily', 'weekly', 'monthly', 'yearly']).optional(),
        recurrence: recurrenceSchema.optional(),
      },
    },
    async (args) => {
      try {
        const snapshot = await space();
        const parent = args.parent
          ? snapshot.tasks.find((task) => task.id === args.parent) ?? null
          : null;
        if (args.parent && !parent) return fail(`Parent task ${args.parent} was not found.`);

        const project = args.project ? findProject(snapshot, args.project) : null;
        if (args.project && !project) {
          const names = snapshot.projects.map((item) => item.name).join(', ') || 'none';
          return fail(`Project "${args.project}" was not found. Projects: ${names}.`);
        }

        if (args.time && !args.date) return fail('A task with a time also needs a date.');
        if (args.endDate && !args.date) return fail('An end date needs a start date.');
        if (args.endTime && !args.time) return fail('An end time needs a start time.');

        const id = randomUUID();
        const title = args.title.trim();
        if (!title) return fail('The task title cannot be empty.');

        const date = args.date ?? null;
        const time = args.allDay ? null : args.time ?? null;
        const allDay = args.allDay ?? !time;
        let endDate = args.endDate ?? date;
        if (date && endDate && endDate < date) endDate = date;
        if (!date) endDate = null;

        const placeName = args.place?.trim() || null;
        if (placeName && !snapshot.places.some((place) => place.name.toLowerCase() === placeName.toLowerCase())) {
          const place = { id: randomUUID(), name: placeName, createdAt: Date.now() };
          await writeEntity(snapshot, 'place', place.id, place);
          snapshot.places.push(place);
        }

        const now = Date.now();
        const task: TaskRecord = {
          id,
          title,
          notes: args.notes ?? '',
          projectId: project?.id ?? parent?.projectId ?? null,
          parentId: parent?.id ?? null,
          place: placeName,
          priority: (args.priority ?? 4) as Priority,
          date,
          time,
          endDate,
          endTime: allDay ? null : args.endTime ?? null,
          allDay,
          tags: args.tags ?? [],
          lane: args.lane ?? '',
          recurrence: normalizeRuleInput(args.repeat, args.recurrence, date),
          reminder: args.reminder ?? true,
          completed: false,
          completedAt: null,
          seriesId: id,
          order: nextOrder(snapshot.tasks),
          createdAt: now,
          updatedAt: now,
        };

        await writeEntity(snapshot, 'task', task.id, task);
        invalidate();
        return ok({ task: toTaskView(snapshot, task) });
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Could not create the task.');
      }
    },
  );

  server.registerTool(
    'update_task',
    {
      title: 'Update task',
      description:
        'Update fields on an existing task. Omitted fields are left unchanged. Setting date to null removes the schedule.',
      inputSchema: {
        id: z.string(),
        title: z.string().min(1).max(500).optional(),
        notes: z.string().optional(),
        project: z.string().nullable().optional().describe('Project name/id, or null for Inbox'),
        parent: z.string().nullable().optional(),
        place: z.string().nullable().optional(),
        priority: z.number().int().min(1).max(4).optional(),
        date: dateSchema.nullable().optional(),
        time: timeSchema.nullable().optional(),
        endDate: dateSchema.nullable().optional(),
        endTime: timeSchema.nullable().optional(),
        allDay: z.boolean().optional(),
        tags: z.array(z.string()).optional(),
        lane: z.string().optional(),
        reminder: z.boolean().optional(),
        repeat: z.enum(['daily', 'weekly', 'monthly', 'yearly']).nullable().optional(),
        recurrence: recurrenceSchema.nullable().optional(),
      },
    },
    async (args) => {
      try {
        const snapshot = await space();
        const task = snapshot.tasks.find((item) => item.id === args.id);
        if (!task) return fail(`Task ${args.id} was not found.`);

        const patch: Partial<TaskRecord> = {};
        if (args.title !== undefined) patch.title = args.title.trim();
        if (args.notes !== undefined) patch.notes = args.notes;
        if (args.place !== undefined) patch.place = args.place?.trim() || null;
        if (args.priority !== undefined) patch.priority = args.priority as Priority;
        if (args.tags !== undefined) patch.tags = args.tags;
        if (args.lane !== undefined) patch.lane = args.lane;
        if (args.reminder !== undefined) patch.reminder = args.reminder;

        if (args.project !== undefined) {
          if (args.project === null) {
            patch.projectId = null;
          } else {
            const project = findProject(snapshot, args.project);
            if (!project) return fail(`Project "${args.project}" was not found.`);
            if (project.id !== task.projectId) {
              patch.projectId = project.id;
              if (args.tags === undefined) patch.tags = [];
            }
          }
        }

        if (args.parent !== undefined) {
          if (args.parent === null) {
            patch.parentId = null;
          } else {
            if (args.parent === task.id) return fail('A task cannot be its own parent.');
            const parent = snapshot.tasks.find((item) => item.id === args.parent);
            if (!parent) return fail(`Parent task ${args.parent} was not found.`);
            if (descendantIds(snapshot.tasks, task.id).includes(parent.id)) {
              return fail('A task cannot be moved under one of its own subtasks.');
            }
            patch.parentId = parent.id;
            if (patch.projectId === undefined) patch.projectId = parent.projectId;
          }
        }

        if (args.date !== undefined) {
          patch.date = args.date;
          if (args.date === null) {
            patch.time = null;
            patch.endDate = null;
            patch.endTime = null;
          } else if (args.endDate === undefined) {
            const existingEnd = task.endDate && task.endDate > args.date ? task.endDate : args.date;
            patch.endDate = existingEnd;
          }
        }
        if (args.endDate !== undefined) patch.endDate = args.endDate;
        if (args.time !== undefined) {
          patch.time = args.time;
          if (args.time) patch.allDay = false;
        }
        if (args.endTime !== undefined) patch.endTime = args.endTime;
        if (args.allDay !== undefined) {
          patch.allDay = args.allDay;
          if (args.allDay) {
            patch.time = null;
            patch.endTime = null;
          }
        }

        if (args.recurrence !== undefined || args.repeat !== undefined) {
          if (args.recurrence === null || args.repeat === null) {
            patch.recurrence = null;
          } else {
            patch.recurrence = normalizeRuleInput(
              args.repeat,
              args.recurrence,
              patch.date ?? task.date,
            );
          }
        }

        if (args.title !== undefined && !patch.title) return fail('The task title cannot be empty.');

        const updated: TaskRecord = { ...task, ...patch, updatedAt: Date.now() };
        await writeEntity(snapshot, 'task', updated.id, updated);
        invalidate();
        return ok({ task: toTaskView(snapshot, updated) });
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Could not update the task.');
      }
    },
  );

  server.registerTool(
    'complete_task',
    {
      title: 'Complete task',
      description:
        'Mark a task complete or open. Completing a recurring task also creates its next occurrence.',
      inputSchema: {
        id: z.string(),
        completed: z.boolean().optional().describe('Default true; false reopens the task'),
      },
    },
    async ({ id, completed }) => {
      try {
        const snapshot = await space();
        const task = snapshot.tasks.find((item) => item.id === id);
        if (!task) return fail(`Task ${id} was not found.`);

        const done = completed ?? true;
        if (done === task.completed) {
          return ok({ task: toTaskView(snapshot, task), changed: false });
        }

        const now = Date.now();
        const updated: TaskRecord = {
          ...task,
          completed: done,
          completedAt: done ? now : null,
          updatedAt: now,
        };
        await writeEntity(snapshot, 'task', updated.id, updated);

        let next: TaskRecord | null = null;
        if (done && task.recurrence && task.date) {
          const nextDate = nextOccurrence(task.recurrence, task.date);
          const occurrences = snapshot.tasks.filter((item) => item.seriesId === task.seriesId).length;
          if (!isExhausted(task.recurrence, nextDate, occurrences)) {
            next = {
              ...task,
              id: randomUUID(),
              date: nextDate,
              endDate: task.endDate ? shiftRange(task.date, task.endDate, nextDate) : nextDate,
              completed: false,
              completedAt: null,
              order: nextOrder(snapshot.tasks),
              createdAt: now,
              updatedAt: now,
            };
            await writeEntity(snapshot, 'task', next.id, next);
          }
        }

        invalidate();
        return ok({
          task: toTaskView(snapshot, updated),
          nextOccurrence: next ? toTaskView(snapshot, next) : null,
        });
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Could not update the task.');
      }
    },
  );

  server.registerTool(
    'delete_task',
    {
      title: 'Delete task',
      description:
        'Permanently delete a task and all of its subtasks from every device. This cannot be undone.',
      inputSchema: {
        id: z.string(),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ id }) => {
      try {
        const snapshot = await space();
        const task = snapshot.tasks.find((item) => item.id === id);
        if (!task) return fail(`Task ${id} was not found.`);
        const ids = [id, ...descendantIds(snapshot.tasks, id)];
        for (const taskId of ids) {
          await writeEntity(snapshot, 'task', taskId, null, true);
        }
        invalidate();
        return ok({ deleted: ids.length, ids });
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Could not delete the task.');
      }
    },
  );
}
