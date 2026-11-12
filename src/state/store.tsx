/**
 * Application state.
 *
 * A single React context owns every domain collection. Every mutation is
 * written through to IndexedDB immediately, so the app is durable by default
 * and can be closed at any moment without losing work.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import {
  clearAll,
  createId,
  db,
  ensureUuids,
  loadSnapshot,
  normalizeSettings,
  resetUuidMigration,
} from '../db/database';
import type {
  BackupFile,
  Category,
  Place,
  Priority,
  Project,
  RecurrenceRule,
  Settings,
  Tag,
  Task,
} from '../domain/types';
import { DEFAULT_SETTINGS } from '../domain/types';
import { isExhausted, nextOccurrence } from '../domain/recurrence';
import { applyCompletion, revertCompletion, type CompletionOutcome, type CompletionUndo } from '../domain/progress';
import {
  disconnectSync,
  getSyncInfo,
  loadSyncRuntime,
  registerApplyHandler,
} from '../sync/engine';
import { requestNotificationSync, resetNotificationSchedule } from '../notifications/engine';

export const PROJECT_COLORS = [
  '#58a6ff', '#3fb950', '#d29922', '#f85149', '#bc8cff',
  '#39c5cf', '#db61a2', '#8b949e', '#a5d6ff', '#ffa657',
];

export const CATEGORY_COLORS = ['#58a6ff', '#3fb950', '#d29922', '#f85149', '#bc8cff', '#39c5cf'];

const BACKUP_VERSION = 4;

export interface NewTaskInput {
  title: string;
  projectId?: string | null;
  projectName?: string | null;
  categoryName?: string | null;
  /** Set to nest this task under another one. */
  parentId?: string | null;
  place?: string | null;
  priority?: Priority;
  date?: string | null;
  time?: string | null;
  endDate?: string | null;
  endTime?: string | null;
  allDay?: boolean;
  notes?: string;
  tags?: string[];
  lane?: string;
  recurrence?: RecurrenceRule | null;
}

interface TaskerContextValue {
  ready: boolean;
  tasks: Task[];
  categories: Category[];
  projects: Project[];
  places: Place[];
  settings: Settings;

  createTask: (input: NewTaskInput) => Promise<Task>;
  updateTask: (id: string, patch: Partial<Task>) => void;
  deleteTask: (id: string) => void;
  /** Returns what to celebrate, or null when a task was un-completed. */
  toggleComplete: (id: string) => CompletionOutcome | null;
  /** Reverses a completion (used by the toast's Undo action). */
  undoCompletion: (undo: CompletionUndo) => void;
  duplicateTask: (id: string) => void;
  reorderTask: (id: string, direction: -1 | 1) => void;
  /** Ids of every descendant of a task, breadth-first. */
  descendantIds: (id: string) => string[];

  createCategory: (name: string, color?: string) => Category;
  updateCategory: (id: string, patch: Partial<Omit<Category, 'id'>>) => void;
  deleteCategory: (id: string) => void;

  createProject: (name: string, options?: { color?: string; categoryId?: string | null }) => Project;
  updateProject: (id: string, patch: Partial<Omit<Project, 'id'>>) => void;
  deleteProject: (id: string) => void;
  addTag: (projectId: string, name: string, color?: string) => void;
  removeTag: (projectId: string, tagId: string) => void;

  ensurePlace: (name: string) => Promise<Place>;
  deletePlace: (id: string) => void;

  updateSettings: (patch: Partial<Settings>) => void;

  buildBackup: () => BackupFile;
  restoreBackup: (backup: BackupFile) => Promise<void>;
  resetEverything: () => Promise<void>;
}

const TaskerContext = createContext<TaskerContextValue | null>(null);

function nextOrder(items: { order: number }[]): number {
  return items.reduce((max, item) => Math.max(max, item.order), 0) + 1;
}

/* ── Pure task-array transforms ───────────────────────────────────────────── */

/**
 * Applies `patch` to one task. When the patch changes the project, the whole
 * subtree follows so a subtask can never belong to a different project than the
 * task it lives under.
 */
function withPatch(all: Task[], id: string, patch: Partial<Task>, subtreeIds: string[]): Task[] {
  const movingProject = patch.projectId !== undefined;
  const target = new Set([id, ...(movingProject ? subtreeIds : [])]);
  const now = Date.now();
  return all.map((task) => {
    if (!target.has(task.id)) return task;
    if (task.id === id) return { ...task, ...patch, updatedAt: now };
    return { ...task, projectId: patch.projectId ?? null, tags: [], updatedAt: now };
  });
}

/** Applies the same patch to many tasks. */
function withMany(all: Task[], ids: string[], patch: Partial<Task>): Task[] {
  if (ids.length === 0) return all;
  const target = new Set(ids);
  const now = Date.now();
  return all.map((task) => (target.has(task.id) ? { ...task, ...patch, updatedAt: now } : task));
}

/** Shifts an end date by however much the start date moved. */
function shiftRange(startISO: string, endISO: string, newStartISO: string): string {
  const start = Date.parse(`${startISO}T00:00:00Z`);
  const end = Date.parse(`${endISO}T00:00:00Z`);
  const shifted = Date.parse(`${newStartISO}T00:00:00Z`) + (end - start);
  return new Date(shifted).toISOString().slice(0, 10);
}

export function TaskerProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [places, setPlaces] = useState<Place[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

  // Refs mirror state so callbacks can read the latest values without being
  // re-created (and without stale closures).
  const tasksRef = useRef(tasks);
  const categoriesRef = useRef(categories);
  const projectsRef = useRef(projects);
  const placesRef = useRef(places);
  const settingsRef = useRef(settings);
  tasksRef.current = tasks;
  categoriesRef.current = categories;
  projectsRef.current = projects;
  placesRef.current = places;
  settingsRef.current = settings;

  useEffect(() => {
    let cancelled = false;

    const applySnapshot = (snapshot: Awaited<ReturnType<typeof loadSnapshot>>) => {
      setTasks(snapshot.tasks);
      setCategories(snapshot.categories);
      setProjects(snapshot.projects);
      setPlaces(snapshot.places);
      setSettings(snapshot.settings);
    };

    const boot = async () => {
      // Legacy ids are migrated once, before the first read, so sync and local
      // data always use the same stable UUIDs.
      await ensureUuids();
      const snapshot = await loadSnapshot();
      if (cancelled) return;
      applySnapshot(snapshot);
      setReady(true);

      registerApplyHandler(() => {
        void loadSnapshot().then((next) => {
          if (!cancelled) applySnapshot(next);
        });
      });
      await loadSyncRuntime();
    };

    void boot();
    return () => {
      cancelled = true;
      registerApplyHandler(null);
    };
  }, []);

  // Reminders are derived from tasks + notification settings. Whenever either
  // changes, reconcile the ntfy schedule in the background (debounced).
  useEffect(() => {
    if (!ready) return;
    requestNotificationSync(settings, tasks, projects);
  }, [ready, settings, tasks, projects]);

  /** Walks the subtask tree below `id`, breadth-first. */
  const descendantIds = useCallback((id: string): string[] => {
    const all = tasksRef.current;
    const out: string[] = [];
    const seen = new Set<string>([id]);
    let frontier = [id];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const parent of frontier) {
        for (const task of all) {
          if (task.parentId === parent && !seen.has(task.id)) {
            seen.add(task.id);
            out.push(task.id);
            next.push(task.id);
          }
        }
      }
      frontier = next;
    }
    return out;
  }, []);

  /** Applies a transform to the task list and writes only what changed. */
  const commitTasks = useCallback((build: (all: Task[]) => Task[]) => {
    setTasks((prev) => {
      const next = build(prev);
      if (next === prev) return prev;
      const changed = next.filter((task, index) => task !== prev[index]);
      if (changed.length > 0) void db.tasks.putMany(changed);
      return next;
    });
  }, []);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      void db.settings.put(next);
      return next;
    });
  }, []);

  /* ── Categories ─────────────────────────────────────────────────────────── */

  const createCategory = useCallback((name: string, color?: string): Category => {
    const category: Category = {
      id: createId('cat'),
      name: name.trim(),
      color: color ?? CATEGORY_COLORS[categoriesRef.current.length % CATEGORY_COLORS.length],
      order: nextOrder(categoriesRef.current),
      createdAt: Date.now(),
    };
    setCategories((prev) => [...prev, category]);
    void db.categories.put(category);
    return category;
  }, []);

  const updateCategory = useCallback((id: string, patch: Partial<Omit<Category, 'id'>>) => {
    setCategories((prev) => {
      const next = prev.map((category) => (category.id === id ? { ...category, ...patch } : category));
      const updated = next.find((category) => category.id === id);
      if (updated) void db.categories.put(updated);
      return next;
    });
  }, []);

  const deleteCategory = useCallback((id: string) => {
    setCategories((prev) => prev.filter((category) => category.id !== id));
    void db.categories.remove(id);
    // Its projects survive and fall back to "Uncategorised".
    setProjects((prev) => {
      const touched = prev.filter((project) => project.categoryId === id);
      const next = prev.map((project) =>
        project.categoryId === id ? { ...project, categoryId: null } : project,
      );
      next
        .filter((project) => touched.some((item) => item.id === project.id))
        .forEach((project) => void db.projects.put(project));
      return next;
    });
  }, []);

  /* ── Projects ───────────────────────────────────────────────────────────── */

  const createProject = useCallback(
    (name: string, options?: { color?: string; categoryId?: string | null }): Project => {
      const project: Project = {
        id: createId('prj'),
        name: name.trim(),
        color: options?.color ?? PROJECT_COLORS[projectsRef.current.length % PROJECT_COLORS.length],
        categoryId: options?.categoryId ?? null,
        tags: [],
        order: nextOrder(projectsRef.current),
        createdAt: Date.now(),
      };
      setProjects((prev) => [...prev, project]);
      void db.projects.put(project);
      return project;
    },
    [],
  );

  const ensureProjectByName = useCallback(
    (name: string, categoryId?: string | null): Project | null => {
      const trimmed = name.trim();
      if (!trimmed) return null;
      const existing = projectsRef.current.find(
        (project) => project.name.toLowerCase() === trimmed.toLowerCase(),
      );
      if (existing) return existing;
      return createProject(trimmed, { categoryId: categoryId ?? null });
    },
    [createProject],
  );

  const updateProject = useCallback((id: string, patch: Partial<Omit<Project, 'id'>>) => {
    setProjects((prev) => {
      const next = prev.map((project) => (project.id === id ? { ...project, ...patch } : project));
      const updated = next.find((project) => project.id === id);
      if (updated) void db.projects.put(updated);
      return next;
    });
  }, []);

  const deleteProject = useCallback((id: string) => {
    setProjects((prev) => prev.filter((project) => project.id !== id));
    void db.projects.remove(id);
    setTasks((prev) => {
      const touched = prev.filter((task) => task.projectId === id);
      const next = prev.map((task) =>
        task.projectId === id ? { ...task, projectId: null, tags: [] } : task,
      );
      next
        .filter((task) => touched.some((item) => item.id === task.id))
        .forEach((task) => void db.tasks.put(task));
      return next;
    });
  }, []);

  const addTag = useCallback((projectId: string, name: string, color?: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setProjects((prev) => {
      const next = prev.map((project) => {
        if (project.id !== projectId) return project;
        if (project.tags.some((tag) => tag.name.toLowerCase() === trimmed.toLowerCase())) return project;
        const tag: Tag = {
          id: createId('tag'),
          name: trimmed,
          color: color ?? PROJECT_COLORS[project.tags.length % PROJECT_COLORS.length],
        };
        return { ...project, tags: [...project.tags, tag] };
      });
      const updated = next.find((project) => project.id === projectId);
      if (updated) void db.projects.put(updated);
      return next;
    });
  }, []);

  const removeTag = useCallback((projectId: string, tagId: string) => {
    setProjects((prev) => {
      const removed = prev.find((project) => project.id === projectId)?.tags.find((tag) => tag.id === tagId);
      const next = prev.map((project) =>
        project.id === projectId
          ? { ...project, tags: project.tags.filter((tag) => tag.id !== tagId) }
          : project,
      );
      const updated = next.find((project) => project.id === projectId);
      if (updated) void db.projects.put(updated);

      if (removed) {
        setTasks((current) => {
          const affected = new Set(
            current
              .filter((task) => task.projectId === projectId && task.tags.includes(removed.name))
              .map((task) => task.id),
          );
          if (affected.size === 0) return current;
          const patched = current.map((task) =>
            affected.has(task.id)
              ? { ...task, tags: task.tags.filter((name) => name !== removed.name), updatedAt: Date.now() }
              : task,
          );
          patched.filter((task) => affected.has(task.id)).forEach((task) => void db.tasks.put(task));
          return patched;
        });
      }
      return next;
    });
  }, []);

  /* ── Places ─────────────────────────────────────────────────────────────── */

  const ensurePlace = useCallback(async (name: string): Promise<Place> => {
    const trimmed = name.trim();
    const existing = placesRef.current.find((place) => place.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) return existing;
    const place: Place = { id: createId('plc'), name: trimmed, createdAt: Date.now() };
    setPlaces((prev) => [...prev, place]);
    await db.places.put(place);
    return place;
  }, []);

  const deletePlace = useCallback((id: string) => {
    setPlaces((prev) => prev.filter((place) => place.id !== id));
    void db.places.remove(id);
  }, []);

  /* ── Tasks ──────────────────────────────────────────────────────────────── */

  const resolveProjectId = useCallback(
    (input: NewTaskInput, inheritedProjectId: string | null): string | null => {
      if (input.projectId) return input.projectId;
      // A subtask inherits its parent's project unless told otherwise.
      if (inheritedProjectId) return inheritedProjectId;

      let categoryId: string | null = null;
      if (input.categoryName) {
        const trimmed = input.categoryName.trim();
        const existing =
          categoriesRef.current.find((category) => category.name.toLowerCase() === trimmed.toLowerCase()) ??
          createCategory(trimmed);
        categoryId = existing.id;
      }

      if (input.projectName) {
        const project = ensureProjectByName(input.projectName, categoryId);
        if (project) return project.id;
      }

      // A category on its own resolves to its only project, if it has one.
      if (categoryId) {
        const owned = projectsRef.current.filter((project) => project.categoryId === categoryId);
        if (owned.length === 1) return owned[0].id;
      }

      return settingsRef.current.defaultProjectId;
    },
    [createCategory, ensureProjectByName],
  );

  const createTask = useCallback(
    async (input: NewTaskInput): Promise<Task> => {
      const parent = input.parentId ? tasksRef.current.find((task) => task.id === input.parentId) : null;
      const projectId = resolveProjectId(input, parent?.projectId ?? null);

      const allDay = input.allDay ?? !input.time;
      const now = Date.now();
      const date = input.date ?? null;
      const endDate = input.endDate && date && input.endDate > date ? input.endDate : date;

      const task: Task = {
        id: createId('tsk'),
        title: input.title.trim() || 'Untitled task',
        notes: input.notes ?? '',
        projectId,
        parentId: input.parentId ?? null,
        place: input.place ?? null,
        priority: input.priority ?? 4,
        date,
        time: allDay ? null : input.time ?? null,
        endDate,
        endTime: allDay ? null : input.endTime ?? null,
        allDay,
        tags: input.tags ?? [],
        lane: input.lane ?? '',
        recurrence: input.recurrence ?? null,
        reminder: true,
        completed: false,
        completedAt: null,
        seriesId: createId('ser'),
        order: nextOrder(tasksRef.current),
        createdAt: now,
        updatedAt: now,
      };

      setTasks((prev) => [...prev, task]);
      await db.tasks.put(task);
      if (task.place) await ensurePlace(task.place);
      return task;
    },
    [ensurePlace, resolveProjectId],
  );

  const updateTask = useCallback(
    (id: string, patch: Partial<Task>) => {
      const subtree = patch.projectId !== undefined ? descendantIds(id) : [];
      commitTasks((all) => withPatch(all, id, patch, subtree));
    },
    [commitTasks, descendantIds],
  );

  const deleteTask = useCallback(
    (id: string) => {
      const ids = [id, ...descendantIds(id)];
      const doomed = new Set(ids);
      setTasks((prev) => prev.filter((task) => !doomed.has(task.id)));
      void db.tasks.removeMany(ids);
    },
    [descendantIds],
  );

  const duplicateTask = useCallback((id: string) => {
    const task = tasksRef.current.find((item) => item.id === id);
    if (!task) return;
    const copy: Task = {
      ...task,
      id: createId('tsk'),
      title: `${task.title} (copy)`,
      completed: false,
      completedAt: null,
      seriesId: createId('ser'),
      order: nextOrder(tasksRef.current),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setTasks((prev) => [...prev, copy]);
    void db.tasks.put(copy);
  }, []);

  const toggleComplete = useCallback(
    (id: string): CompletionOutcome | null => {
      const task = tasksRef.current.find((item) => item.id === id);
      if (!task) return null;

      const all = tasksRef.current;
      const descendants = descendantIds(id);
      const now = Date.now();

      if (task.completed) {
        commitTasks((current) => withPatch(current, id, { completed: false, completedAt: null }, []));
        return null;
      }

      // A checklist is "cleared" when this tick finishes the last item of a
      // parent — that earns the bonus and its own celebration.
      let clearedParentId: string | null = null;
      if (task.parentId) {
        const siblings = all.filter((item) => item.parentId === task.parentId && item.id !== id);
        if (siblings.length > 0 && siblings.every((item) => item.completed)) clearedParentId = task.parentId;
      } else {
        const children = all.filter((item) => item.parentId === id);
        if (children.length > 0 && children.every((item) => item.completed)) clearedParentId = id;
      }

      // Recurring tasks roll forward: the checklist moves to the new occurrence
      // instead of being completed, and undo would be ambiguous.
      const recurring = Boolean(task.recurrence && task.date);
      const occurrences = recurring ? all.filter((item) => item.seriesId === task.seriesId).length : 0;
      const nextDate = recurring ? nextOccurrence(task.recurrence!, task.date!) : null;
      const exhausted = recurring && nextDate ? isExhausted(task.recurrence!, nextDate, occurrences) : false;
      const rollsOver = Boolean(recurring && nextDate && !exhausted);

      const completedAlongside = rollsOver ? [] : descendants;
      const outcome = applyCompletion(
        settingsRef.current.progress,
        task,
        clearedParentId,
        completedAlongside,
        now,
      );
      updateSettings({ progress: outcome.progress });

      const done = { completed: true, completedAt: now };

      if (recurring && nextDate) {
        commitTasks((current) => {
          let next = withPatch(current, id, done, []);
          if (exhausted) return withMany(next, descendants, done);

          const occurrence: Task = {
            ...task,
            id: createId('tsk'),
            date: nextDate,
            endDate: task.endDate ? shiftRange(task.date!, task.endDate, nextDate) : nextDate,
            completed: false,
            completedAt: null,
            order: nextOrder(all),
            createdAt: now,
            updatedAt: now,
          };

          // The checklist moves onto the fresh occurrence and resets.
          next = next.map((item) => {
            if (!descendants.includes(item.id)) return item;
            return {
              ...item,
              parentId: item.parentId === id ? occurrence.id : item.parentId,
              completed: false,
              completedAt: null,
              updatedAt: now,
            };
          });

          return [...next, occurrence];
        });

        return rollsOver ? { ...outcome, undo: null } : outcome;
      }

      // Completing a parent completes its whole subtree.
      commitTasks((current) => withMany(withPatch(current, id, done, []), descendants, done));
      return outcome;
    },
    [commitTasks, descendantIds, updateSettings],
  );

  /** One-tap reversal offered by the completion toast. */
  const undoCompletion = useCallback(
    (undo: CompletionUndo) => {
      const ids = [undo.taskId, ...undo.alsoCompletedIds];
      commitTasks((current) =>
        withMany(current, ids, { completed: false, completedAt: null }),
      );
      updateSettings({ progress: revertCompletion(settingsRef.current.progress, undo) });
    },
    [commitTasks, updateSettings],
  );

  const reorderTask = useCallback((id: string, direction: -1 | 1) => {
    commitTasks((all) => {
      const sorted = [...all].sort((a, b) => a.order - b.order);
      const index = sorted.findIndex((task) => task.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= sorted.length) return all;
      const first = sorted[index];
      const second = sorted[target];
      const firstOrder = first.order;
      return all.map((task) => {
        if (task.id === first.id) return { ...task, order: second.order, updatedAt: Date.now() };
        if (task.id === second.id) return { ...task, order: firstOrder, updatedAt: Date.now() };
        return task;
      });
    });
  }, [commitTasks]);

  /* ── Data portability ───────────────────────────────────────────────────── */

  const buildBackup = useCallback(
    (): BackupFile => ({
      app: 'tasker',
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      categories: categoriesRef.current,
      projects: projectsRef.current,
      places: placesRef.current,
      tasks: tasksRef.current,
      settings: settingsRef.current,
    }),
    [],
  );

  const restoreBackup = useCallback(async (backup: BackupFile) => {
    if (!backup || backup.app !== 'tasker' || !Array.isArray(backup.tasks)) {
      throw new Error('This file is not a Tasker backup.');
    }
    if (await getSyncInfo()) {
      throw new Error('Disconnect sync before restoring a backup.');
    }
    await resetNotificationSchedule();
    await clearAll();

    const restoredCategories = backup.categories ?? [];
    const restoredProjects = backup.projects ?? [];
    const restoredPlaces = backup.places ?? [];
    const restoredTasks = backup.tasks ?? [];
    const restoredSettings = normalizeSettings(backup.settings);

    await db.categories.putMany(restoredCategories);
    await db.projects.putMany(restoredProjects);
    await db.places.putMany(restoredPlaces);
    await db.tasks.putMany(restoredTasks);
    await db.settings.put(restoredSettings);

    // Imports may still carry legacy string ids; migrate them to UUIDs and read
    // the rewritten rows back so state matches IndexedDB exactly.
    await resetUuidMigration();
    await ensureUuids();
    const snapshot = await loadSnapshot();
    setCategories(snapshot.categories);
    setProjects(snapshot.projects);
    setPlaces(snapshot.places);
    setTasks(snapshot.tasks);
    setSettings(snapshot.settings);
  }, []);

  const resetEverything = useCallback(async () => {
    await resetNotificationSchedule();
    await disconnectSync();
    await clearAll();
    setCategories([]);
    setProjects([]);
    setPlaces([]);
    setTasks([]);
    setSettings(normalizeSettings({}));
  }, []);

  const value = useMemo<TaskerContextValue>(
    () => ({
      ready,
      tasks,
      categories,
      projects,
      places,
      settings,
      createTask,
      updateTask,
      deleteTask,
      toggleComplete,
      undoCompletion,
      duplicateTask,
      reorderTask,
      descendantIds,
      createCategory,
      updateCategory,
      deleteCategory,
      createProject,
      updateProject,
      deleteProject,
      addTag,
      removeTag,
      ensurePlace,
      deletePlace,
      updateSettings,
      buildBackup,
      restoreBackup,
      resetEverything,
    }),
    [
      ready,
      tasks,
      categories,
      projects,
      places,
      settings,
      createTask,
      updateTask,
      deleteTask,
      toggleComplete,
      undoCompletion,
      duplicateTask,
      reorderTask,
      descendantIds,
      createCategory,
      updateCategory,
      deleteCategory,
      createProject,
      updateProject,
      deleteProject,
      addTag,
      removeTag,
      ensurePlace,
      deletePlace,
      updateSettings,
      buildBackup,
      restoreBackup,
      resetEverything,
    ],
  );

  return <TaskerContext.Provider value={value}>{children}</TaskerContext.Provider>;
}

export function useTasker(): TaskerContextValue {
  const context = useContext(TaskerContext);
  if (!context) throw new Error('useTasker must be used inside <TaskerProvider>.');
  return context;
}

/** Convenience selectors shared by the views. */
export function useProjectMap(): Map<string, Project> {
  const { projects } = useTasker();
  return useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
}

/** Tasks bucketed by parent id, so nested rendering is a single lookup. */
export function useTaskChildren(): Map<string, Task[]> {
  const { tasks } = useTasker();
  return useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of tasks) {
      if (!task.parentId) continue;
      const bucket = map.get(task.parentId) ?? [];
      bucket.push(task);
      map.set(task.parentId, bucket);
    }
    for (const bucket of map.values()) bucket.sort((a, b) => a.order - b.order);
    return map;
  }, [tasks]);
}
