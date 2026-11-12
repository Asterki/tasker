/**
 * Tasker domain model.
 *
 * Everything the app knows about is described here. Records are stored verbatim
 * in IndexedDB, so these shapes double as the on-disk schema (see `src/db/database.ts`).
 *
 * Hierarchy:  Category  ->  Project  ->  Task  ->  Subtask (infinitely nested)
 */

/** Todoist-style priority: 1 is the most urgent, 4 is the default / none. */
export type Priority = 1 | 2 | 3 | 4;

export type RecurrenceFreq = 'daily' | 'weekly' | 'monthly' | 'yearly';

/** A recurrence rule supports simple cycles and custom patterns. */
export interface RecurrenceRule {
  freq: RecurrenceFreq;
  /** Every N days / weeks / months / years. */
  interval: number;
  /** For weekly rules: 0 (Sunday) – 6 (Saturday). Empty means "same weekday as the task". */
  byWeekday: number[];
  /** For monthly / yearly rules: explicit day-of-month numbers. */
  byMonthDay: number[];
  /** Optional hard stop. */
  until: string | null;
  /** Optional maximum number of occurrences. */
  count: number | null;
}

/** A top-level grouping of projects, e.g. "Work", "Personal". */
export interface Category {
  id: string;
  name: string;
  color: string;
  order: number;
  createdAt: number;
}

/** A tag belongs to exactly one project. */
export interface Tag {
  id: string;
  name: string;
  color: string;
}

export interface Project {
  id: string;
  name: string;
  color: string;
  /** Owning category, or null for "Uncategorised". */
  categoryId: string | null;
  tags: Tag[];
  order: number;
  createdAt: number;
}

/** A contextual or physical location, e.g. `@work`, `@home`, `@downtown`. */
export interface Place {
  id: string;
  name: string;
  createdAt: number;
}

export interface Task {
  id: string;
  title: string;
  notes: string;
  projectId: string | null;

  /**
   * Parent task for subtasks. Subtasks are ordinary tasks, so nesting is
   * unlimited and every subtask supports the full metadata set.
   */
  parentId: string | null;

  place: string | null;
  priority: Priority;

  /** Start of the task as `YYYY-MM-DD`, or null for "someday". */
  date: string | null;
  /** Start time as `HH:mm` (24h). Null when all-day or unscheduled. */
  time: string | null;
  /**
   * End of the task. Null (or equal to `date`) means the task finishes the same
   * day it starts; a later date makes it a multi-day task.
   */
  endDate: string | null;
  /** End time as `HH:mm`. Null when there is no explicit finish time. */
  endTime: string | null;
  /** True for day-level events, false for micro-scheduled timeframes. */
  allDay: boolean;

  /** Names of the project tags attached to this task. */
  tags: string[];
  /** Groups tasks into an execution sequence on the roadmap. */
  lane: string;
  recurrence: RecurrenceRule | null;

  /** Whether this task should publish ntfy reminders. Dated tasks default to true. */
  reminder: boolean;

  completed: boolean;
  completedAt: number | null;
  /** Stable id shared by every occurrence generated from one recurring task. */
  seriesId: string;

  order: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Running totals for the completion loop. Kept as accumulated numbers rather
 * than derived from the task list so deleting old tasks never rewinds progress.
 */
export interface Progress {
  xp: number;
  totalCompleted: number;
  /** Consecutive days with at least one completion. */
  streak: number;
  bestStreak: number;
  /** `YYYY-MM-DD` of the most recent completion. */
  lastCompletionDate: string | null;
  /** Completions on `todayDate`, used for milestone messages. */
  todayCount: number;
  todayDate: string | null;
  /** Most completions in a single day. */
  bestDayCount: number;
  /** Rapid-fire completion combo, and when the last link landed. */
  combo: number;
  bestCombo: number;
  lastComboAt: number | null;
  /** How many parent checklists have been fully cleared. */
  checklistsCleared: number;
  /** Unlocked achievement ids. */
  unlocked: string[];
  /** Epoch ms of the last progress mutation, used to order synced records. */
  updatedAt: number;
}

export const EMPTY_PROGRESS: Progress = {
  xp: 0,
  totalCompleted: 0,
  streak: 0,
  bestStreak: 0,
  lastCompletionDate: null,
  todayCount: 0,
  todayDate: null,
  bestDayCount: 0,
  combo: 0,
  bestCombo: 0,
  lastComboAt: null,
  checklistsCleared: 0,
  unlocked: [],
  updatedAt: 0,
};

export interface NotificationSettings {
  /** Publish reminders at all. */
  enabled: boolean;
  /** ntfy base URL, e.g. https://ntfy.sh or https://ntfy.example.com. */
  serverUrl: string;
  /** ntfy topic. Treat it as a password; pick something hard to guess. */
  topic: string;
  /** Optional ntfy access token (sent as a bearer token). */
  token: string;
  /** How many reminders per day for tasks that have a date but no time. */
  allDayCount: number;
}

export interface Settings {
  /** Single key/value bag persisted in IndexedDB. */
  theme: 'nordic-light' | 'nordic-dark';
  defaultProjectId: string | null;
  /** Gamification state driven by task completions. */
  progress: Progress;
  /** Plays a short chime on completion. Off by default. */
  soundEnabled: boolean;
  /** Vibrates on completion where the device supports it. */
  hapticsEnabled: boolean;
  /** IANA timezone used to turn task dates/times into absolute reminder instants. */
  timezone: string;
  /** ntfy reminder delivery. */
  notifications: NotificationSettings;
}

export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  enabled: false,
  serverUrl: 'https://ntfy.sh',
  topic: '',
  token: '',
  allDayCount: 1,
};

export const DEFAULT_SETTINGS: Settings = {
  theme: 'nordic-dark',
  defaultProjectId: null,
  progress: {
    xp: 0,
    totalCompleted: 0,
    streak: 0,
    bestStreak: 0,
    lastCompletionDate: null,
    todayCount: 0,
    todayDate: null,
    bestDayCount: 0,
    combo: 0,
    bestCombo: 0,
    lastComboAt: null,
    checklistsCleared: 0,
    unlocked: [],
    updatedAt: 0,
  },
  soundEnabled: false,
  hapticsEnabled: true,
  timezone: 'UTC',
  notifications: { ...DEFAULT_NOTIFICATIONS },
};

/** Shape of a full JSON backup produced by "Export". */
export interface BackupFile {
  app: 'tasker';
  version: number;
  exportedAt: string;
  categories: Category[];
  projects: Project[];
  places: Place[];
  tasks: Task[];
  settings: Settings;
}
