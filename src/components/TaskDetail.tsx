/**
 * Task detail editor. Rendered inside the mobile bottom sheet and inside the
 * desktop side panel — the content is identical, only the chrome differs.
 */

import { useMemo } from 'react';
import { FiX } from 'react-icons/fi';
import type { Priority, Task } from '../domain/types';
import { formatDate, formatTime, spanLength, todayISO } from '../domain/date';
import { RecurrenceEditor } from './RecurrenceEditor';
import { TaskTree } from './TaskTree';
import { QuickAdd } from './QuickAdd';
import { useTaskChildren, useTasker } from '../state/store';

interface TaskDetailProps {
  task: Task;
  onClose: () => void;
  onOpenTask: (task: Task) => void;
}

const PRIORITIES: { value: Priority; label: string }[] = [
  { value: 1, label: 'P1 · Urgent' },
  { value: 2, label: 'P2 · High' },
  { value: 3, label: 'P3 · Medium' },
  { value: 4, label: 'P4 · None' },
];

export function TaskDetail({ task, onClose, onOpenTask }: TaskDetailProps) {
  const {
    categories,
    projects,
    places,
    settings,
    tasks,
    updateTask,
    deleteTask,
    duplicateTask,
    descendantIds,
    addTag,
    removeTag,
  } = useTasker();
  const childrenMap = useTaskChildren();

  const children = childrenMap.get(task.id) ?? [];
  const parent = task.parentId ? tasks.find((item) => item.id === task.parentId) ?? null : null;
  const ancestors = useMemo(() => {
    const chain: Task[] = [];
    let cursor = parent;
    const guard = new Set<string>();
    while (cursor && !guard.has(cursor.id)) {
      guard.add(cursor.id);
      chain.unshift(cursor);
      cursor = cursor.parentId ? tasks.find((item) => item.id === cursor!.parentId) ?? null : null;
    }
    return chain;
  }, [parent, tasks]);

  const categoryId = task.projectId
    ? projects.find((project) => project.id === task.projectId)?.categoryId ?? null
    : null;

  function patch(changes: Partial<Task>) {
    updateTask(task.id, changes);
  }

  /** Projects grouped by category, for the hierarchical picker. */
  const grouped = useMemo(() => {
    const groups: { key: string; label: string; projects: typeof projects }[] = categories.map((category) => ({
      key: category.id,
      label: category.name,
      projects: projects.filter((project) => project.categoryId === category.id),
    }));
    const loose = projects.filter((project) => !project.categoryId);
    if (loose.length > 0) groups.push({ key: 'none', label: 'Uncategorised', projects: loose });
    return groups.filter((group) => group.projects.length > 0);
  }, [categories, projects]);

  const project = projects.find((item) => item.id === task.projectId) ?? null;
  const days = spanLength(task.date, task.endDate);

  /** Keeps the end of the range coherent with its start. */
  function patchStart(nextDate: string | null, nextTime: string | null) {
    const endDate = task.endDate && nextDate && task.endDate > nextDate ? task.endDate : nextDate;
    patch({ date: nextDate, time: nextTime, endDate, allDay: !nextTime });
  }

  function patchEnd(nextEndDate: string | null) {
    const clamped = task.date && nextEndDate && nextEndDate < task.date ? task.date : nextEndDate;
    patch({ endDate: clamped });
  }

  function patchEndTime(nextEndTime: string | null) {
    if (nextEndTime && task.time && nextEndTime <= task.time) {
      patch({ endTime: task.time });
      return;
    }
    patch({ endTime: nextEndTime });
  }

  function toggleTag(name: string) {
    const has = task.tags.includes(name);
    patch({ tags: has ? task.tags.filter((tag) => tag !== name) : [...task.tags, name] });
  }

  return (
    <div className="detail">
      {(ancestors.length > 0 || parent) && (
        <nav className="detail__breadcrumb" aria-label="Task hierarchy">
          {ancestors.map((ancestor) => (
            <button key={ancestor.id} type="button" className="link-button" onClick={() => onOpenTask(ancestor)}>
              {ancestor.title}
            </button>
          ))}
          {parent && (
            <button type="button" className="link-button" onClick={() => onOpenTask(parent)}>
              {parent.title}
            </button>
          )}
          <span className="detail__breadcrumb-current">{task.title}</span>
        </nav>
      )}

      <input
        className="detail__title"
        value={task.title}
        onChange={(event) => patch({ title: event.target.value })}
        placeholder="Task title"
        aria-label="Task title"
      />

      <textarea
        className="detail__notes input"
        rows={3}
        value={task.notes}
        onChange={(event) => patch({ notes: event.target.value })}
        placeholder="Notes, links, context…"
        aria-label="Task notes"
      />

      <div className="detail__grid">
        <label className="field">
          <span className="field__label">Project</span>
          <select
            className="input"
            value={task.projectId ?? ''}
            onChange={(event) => patch({ projectId: event.target.value || null, tags: [] })}
          >
            <option value="">No project</option>
            {grouped.map((group) => (
              <optgroup key={group.key} label={group.label}>
                {group.projects.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="field__label">Priority</span>
          <select
            className="input"
            value={task.priority}
            onChange={(event) => patch({ priority: Number(event.target.value) as Priority })}
          >
            {PRIORITIES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="field__label">Place / context</span>
          <input
            className="input"
            list="tasker-places"
            value={task.place ?? ''}
            onChange={(event) => patch({ place: event.target.value || null })}
            placeholder="@work, @home…"
          />
          <datalist id="tasker-places">
            {places.map((place) => (
              <option key={place.id} value={place.name} />
            ))}
          </datalist>
        </label>

        <label className="field">
          <span className="field__label">Start date</span>
          <input
            className="input"
            type="date"
            value={task.date ?? ''}
            onChange={(event) => patchStart(event.target.value || null, task.allDay ? null : task.time)}
          />
        </label>

        <label className="field">
          <span className="field__label">End date {days > 1 ? `· ${days} days` : ''}</span>
          <input
            className="input"
            type="date"
            min={task.date ?? undefined}
            value={task.endDate ?? task.date ?? ''}
            disabled={!task.date}
            onChange={(event) => patchEnd(event.target.value || null)}
          />
        </label>

        <div className="field">
          <span className="field__label">Time</span>
          <div className="field__row">
            <label className="switch">
              <input
                type="checkbox"
                checked={task.allDay}
                onChange={(event) =>
                  patch({ allDay: event.target.checked, time: event.target.checked ? null : task.time, endTime: event.target.checked ? null : task.endTime })
                }
              />
              <span>All-day</span>
            </label>
            <input
              className="input"
              type="time"
              value={task.time ?? ''}
              disabled={task.allDay}
              aria-label="Start time"
              onChange={(event) => patch({ time: event.target.value || null, allDay: false })}
            />
            <span className="field__suffix">to</span>
            <input
              className="input"
              type="time"
              value={task.endTime ?? ''}
              disabled={task.allDay}
              aria-label="End time"
              onChange={(event) => patchEndTime(event.target.value || null)}
            />
          </div>
        </div>

        <div className="field">
          <span className="field__label">Reminder</span>
          <label className="switch">
            <input
              type="checkbox"
              checked={task.reminder !== false}
              disabled={!task.date}
              onChange={(event) => patch({ reminder: event.target.checked })}
            />
            <span>
              {!task.date
                ? 'Add a date to schedule a reminder'
                : task.allDay
                  ? `${settings.notifications.allDayCount}× per day · ${settings.timezone}`
                  : task.time
                    ? `At ${formatTime(task.time)} · ${settings.timezone}`
                    : `At task time · ${settings.timezone}`}
              {task.date && !settings.notifications.enabled ? ' · enable ntfy in Settings' : ''}
            </span>
          </label>
        </div>

        <label className="field">
          <span className="field__label">Roadmap lane</span>
          <input
            className="input"
            list="tasker-lanes"
            value={task.lane}
            placeholder="e.g. Design, Build, Ship"
            onChange={(event) => patch({ lane: event.target.value })}
          />
          <datalist id="tasker-lanes">
            <option value="Backlog" />
            <option value="In progress" />
            <option value="Review" />
            <option value="Done" />
          </datalist>
        </label>
      </div>

      {project && (
        <div className="field">
          <span className="field__label">
            {project.name} tags
            <button
              type="button"
              className="link-button"
              onClick={() => {
                const name = window.prompt('New tag name');
                if (name) addTag(project.id, name);
              }}
            >
              + new tag
            </button>
          </span>
          <div className="tag-picker">
            {project.tags.length === 0 && <span className="muted">No tags in this project yet.</span>}
            {project.tags.map((tag) => {
              const active = task.tags.includes(tag.name);
              return (
                <span key={tag.id} className="tag-pill">
                  <button
                    type="button"
                    className={`chip chip--toggle${active ? ' chip--on' : ''}`}
                    onClick={() => toggleTag(tag.name)}
                    aria-pressed={active}
                  >
                    <span className="dot" style={{ background: tag.color }} />
                    {tag.name}
                  </button>
                  <button
                    type="button"
                    className="tag-pill__remove"
                    onClick={() => removeTag(project.id, tag.id)}
                    aria-label={`Delete tag ${tag.name}`}
                  >
                    <FiX aria-hidden="true" />
                  </button>
                </span>
              );
            })}
          </div>
        </div>
      )}

      <RecurrenceEditor value={task.recurrence} dateISO={task.date} onChange={(rule) => patch({ recurrence: rule })} />

      <section className="detail__subtasks">
        <header className="group__header">
          <span className="group__title">Subtasks</span>
          <span className="group__count">{children.length}</span>
        </header>

        <QuickAdd
          compact
          parentId={task.id}
          projectId={task.projectId}
          defaultDate={task.date}
          placeholder="Add a subtask — same syntax as any task…"
        />

        {children.length > 0 && (
          <TaskTree
            tasks={children}
            childrenMap={childrenMap}
            onOpenTask={onOpenTask}
            showProject={false}
          />
        )}
      </section>

      <div className="detail__meta">
        <span>Created {formatDate(new Date(task.createdAt).toISOString().slice(0, 10))}</span>
        {task.date && task.time && (
          <span className="meta--muted">
            {formatTime(task.time)}
            {task.endTime ? ` – ${formatTime(task.endTime)}` : ''}
          </span>
        )}
        {categoryId && <span className="meta--muted">{categories.find((c) => c.id === categoryId)?.name}</span>}
        {descendantIds(task.id).length > 0 && (
          <span className="meta--muted">{descendantIds(task.id).length} nested</span>
        )}
      </div>

      <div className="detail__actions">
        <button
          type="button"
          className="button"
          onClick={() => {
            duplicateTask(task.id);
            onClose();
          }}
        >
          Duplicate
        </button>
        <button type="button" className="button" onClick={() => patch({ date: todayISO(), endDate: todayISO() })}>
          Schedule today
        </button>
        <button
          type="button"
          className="button button--danger"
          onClick={() => {
            const nested = descendantIds(task.id).length;
            const message = nested
              ? `Delete “${task.title}” and its ${nested} nested task${nested === 1 ? '' : 's'}?`
              : `Delete “${task.title}”?`;
            if (window.confirm(message)) {
              deleteTask(task.id);
              onClose();
            }
          }}
        >
          Delete
        </button>
      </div>
    </div>
  );
}
