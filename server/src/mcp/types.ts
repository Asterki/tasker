/** Domain shapes shared by the MCP tools. These mirror `src/domain/types.ts`. */

export type Priority = 1 | 2 | 3 | 4;
export type RecurrenceFreq = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface RecurrenceRule {
  freq: RecurrenceFreq;
  interval: number;
  byWeekday: number[];
  byMonthDay: number[];
  until: string | null;
  count: number | null;
}

export interface TaskRecord {
  id: string;
  title: string;
  notes: string;
  projectId: string | null;
  parentId: string | null;
  place: string | null;
  priority: Priority;
  date: string | null;
  time: string | null;
  endDate: string | null;
  endTime: string | null;
  allDay: boolean;
  tags: string[];
  lane: string;
  recurrence: RecurrenceRule | null;
  reminder: boolean;
  completed: boolean;
  completedAt: number | null;
  seriesId: string;
  order: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectRecord {
  id: string;
  name: string;
  color: string;
  categoryId: string | null;
  tags: { id: string; name: string; color: string }[];
  order: number;
  createdAt: number;
}

export interface CategoryRecord {
  id: string;
  name: string;
  color: string;
  order: number;
  createdAt: number;
}

export interface PlaceRecord {
  id: string;
  name: string;
  createdAt: number;
}

export interface SyncEntity {
  entityType: string;
  entityId: string;
  hlc: string;
  value: unknown;
}
