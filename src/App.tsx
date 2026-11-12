/**
 * Tasker application shell.
 *
 * Owns navigation, keyboard shortcuts, the responsive layout (desktop rail +
 * side panel vs. mobile tab bar + bottom sheets) and the in-app user manual.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { FiCalendar, FiList, FiMap, FiPlus, FiSettings, FiX } from 'react-icons/fi';
import type { IconType } from 'react-icons';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { BottomSheet } from './components/BottomSheet';
import { QuickAdd } from './components/QuickAdd';
import { TaskDetail } from './components/TaskDetail';
import { CelebrationProvider } from './components/Celebration';
import { TasksView } from './views/TasksView';
import { CalendarView } from './views/CalendarView';
import { RoadmapView } from './views/RoadmapView';
import { SettingsView } from './views/SettingsView';
import { UserManual } from './docs/UserManual';
import { INITIAL_SELECTION, type NavSelection, type ViewKey } from './state/navigation';
import { CATEGORY_COLORS, PROJECT_COLORS, useTasker } from './state/store';
import { useMediaQuery } from './state/hooks';
import type { Category, Project, Task } from './domain/types';

type FocusTarget = 'quickadd' | 'search' | null;

const TAB_LABELS: Record<ViewKey, string> = {
  tasks: 'Tasks',
  calendar: 'Calendar',
  roadmap: 'Roadmap',
  settings: 'More',
};

const TAB_ICONS: Record<ViewKey, IconType> = {
  tasks: FiList,
  calendar: FiCalendar,
  roadmap: FiMap,
  settings: FiSettings,
};

const LANDING: NavSelection = INITIAL_SELECTION;

export function App() {
  const {
    ready,
    tasks,
    categories,
    projects,
    settings,
    createCategory,
    updateCategory,
    deleteCategory,
    createProject,
    updateProject,
    deleteProject,
  } = useTasker();
  const isMobile = useMediaQuery('(max-width: 860px)');

  const [selection, setSelection] = useState<NavSelection>(LANDING);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [focusTarget, setFocusTarget] = useState<FocusTarget>(null);
  const [mobileCreateOpen, setMobileCreateOpen] = useState(false);

  const openTask = useMemo(
    () => (openTaskId ? tasks.find((task) => task.id === openTaskId) ?? null : null),
    [openTaskId, tasks],
  );

  // Reminder notifications deep-link to `/?task=<id>`. Open it once the task
  // exists, then drop the parameter so reloads do not reopen the panel.
  useEffect(() => {
    if (!ready) return;
    const params = new URLSearchParams(window.location.search);
    const taskId = params.get('task');
    if (!taskId || !tasks.some((task) => task.id === taskId)) return;
    setOpenTaskId(taskId);
    params.delete('task');
    const search = params.toString();
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`,
    );
  }, [ready, tasks]);

  // Theme is a data attribute on <html>; all colours come from CSS variables.
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  // Close the detail panel if the underlying task disappears.
  useEffect(() => {
    if (openTaskId && ready && !tasks.some((task) => task.id === openTaskId)) setOpenTaskId(null);
  }, [openTaskId, ready, tasks]);

  const requestFocus = useCallback((target: Exclude<FocusTarget, null>) => {
    setSelection((prev) =>
      prev.view === 'tasks' && (target !== 'quickadd' || prev.scope !== 'completed')
        ? prev
        : { ...prev, view: 'tasks', scope: 'scheduled', projectId: null, categoryId: null, place: null },
    );
    setFocusTarget(target);
  }, []);

  const navigate = useCallback((next: NavSelection) => {
    setSelection(next);
    setOpenTaskId(null);
  }, []);

  const onOpenTask = useCallback((task: Task) => setOpenTaskId(task.id), []);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    function isTyping(target: EventTarget | null): boolean {
      const element = target as HTMLElement | null;
      if (!element) return false;
      const tag = element.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey) {
        if (event.key.toLowerCase() === 'k') {
          event.preventDefault();
          requestFocus('search');
        }
        return;
      }

      if (event.key === 'Escape') {
        setManualOpen(false);
        setOpenTaskId(null);
        setMobileCreateOpen(false);
        return;
      }

      if (isTyping(event.target)) return;
      if (event.altKey) return;

      switch (event.key) {
        case 'n':
          event.preventDefault();
          requestFocus('quickadd');
          break;
        case '/':
          event.preventDefault();
          requestFocus('search');
          break;
        case '1':
          setSelection(LANDING);
          break;
        case '2':
          setSelection((prev) => ({ ...prev, view: 'calendar' }));
          break;
        case '3':
          setSelection((prev) => ({ ...prev, view: 'roadmap' }));
          break;
        case '4':
          setSelection((prev) => ({ ...prev, view: 'settings' }));
          break;
        case 't':
          setSelection({ ...LANDING, scope: 'today' });
          break;
        case '?':
          setManualOpen((open) => !open);
          break;
        default:
          break;
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [requestFocus]);

  /* ── Category + project management (prompt driven, dependency free) ─────── */

  function handleCreateCategory() {
    const name = window.prompt('Category name — e.g. Work, Personal');
    if (!name?.trim()) return;
    const category = createCategory(name.trim());
    setSelection({ ...LANDING, scope: 'category', categoryId: category.id });
  }

  function handleCategoryMenu(category: Category) {
    const choice = window.prompt(
      `“${category.name}”\n\n1 — Rename\n2 — Change colour\n3 — Delete category\n\nEnter a number:`,
      '1',
    );
    if (choice === '1') {
      const name = window.prompt('New category name', category.name);
      if (name?.trim()) updateCategory(category.id, { name: name.trim() });
    } else if (choice === '2') {
      const index = CATEGORY_COLORS.indexOf(category.color);
      updateCategory(category.id, { color: CATEGORY_COLORS[(index + 1) % CATEGORY_COLORS.length] });
    } else if (choice === '3') {
      if (window.confirm(`Delete “${category.name}”? Its projects move to Uncategorised.`)) {
        deleteCategory(category.id);
        setSelection(LANDING);
      }
    }
  }

  function handleCreateProject(categoryId: string | null) {
    const name = window.prompt(
      categoryId
        ? `Project name in “${categories.find((c) => c.id === categoryId)?.name ?? 'category'}”`
        : 'Project name',
    );
    if (!name?.trim()) return;
    const project = createProject(name.trim(), { categoryId });
    setSelection({ ...LANDING, scope: 'project', projectId: project.id });
  }

  function handleProjectMenu(project: Project) {
    const current = categories.find((c) => c.id === project.categoryId)?.name ?? 'Uncategorised';
    const choice = window.prompt(
      `“${project.name}”  (in ${current})\n\n1 — Rename\n2 — Change colour\n3 — Move to category\n4 — Delete project\n\nEnter a number:`,
      '1',
    );

    if (choice === '1') {
      const name = window.prompt('New project name', project.name);
      if (name?.trim()) updateProject(project.id, { name: name.trim() });
      return;
    }
    if (choice === '2') {
      const index = PROJECT_COLORS.indexOf(project.color);
      updateProject(project.id, { color: PROJECT_COLORS[(index + 1) % PROJECT_COLORS.length] });
      return;
    }
    if (choice === '3') {
      if (categories.length === 0) {
        window.alert('Create a category first.');
        return;
      }
      const options = categories.map((category, index) => `${index + 1} — ${category.name}`).join('\n');
      const picked = window.prompt(`${options}\n0 — Uncategorised\n\nMove to which category?`, '1');
      const index = Number(picked);
      if (Number.isNaN(index)) return;
      updateProject(project.id, { categoryId: index === 0 ? null : categories[index - 1]?.id ?? null });
      return;
    }
    if (choice === '4') {
      if (window.confirm(`Delete “${project.name}”? Its tasks move to the Inbox.`)) {
        deleteProject(project.id);
        setSelection(LANDING);
      }
    }
  }

  const viewTitle = useMemo(() => {
    switch (selection.scope) {
      case 'scheduled':
        return 'Scheduled';
      case 'today':
        return 'Today';
      case 'upcoming':
        return 'Upcoming';
      case 'inbox':
        return 'Inbox';
      case 'completed':
        return 'Completed';
      case 'project':
        return projects.find((project) => project.id === selection.projectId)?.name ?? 'Project';
      case 'category':
        return selection.categoryId
          ? categories.find((category) => category.id === selection.categoryId)?.name ?? 'Category'
          : 'Uncategorised';
      case 'place':
        return `@${selection.place}`;
      case 'all':
      default:
        return 'All tasks';
    }
  }, [selection, projects, categories]);

  const detailBody = openTask ? (
    <TaskDetail task={openTask} onClose={() => setOpenTaskId(null)} onOpenTask={onOpenTask} />
  ) : null;

  if (!ready) {
    return (
      <div className="boot">
        <p>Loading your tasks…</p>
      </div>
    );
  }

  return (
    <CelebrationProvider>
      <div className={`app${isMobile ? ' app--mobile' : ' app--desktop'}`}>
        <TopBar
          onFocusSearch={() => requestFocus('search')}
          onFocusQuickAdd={() => requestFocus('quickadd')}
        />

        <div className="app__body">
          {!isMobile && (
            <Sidebar
              selection={selection}
              onSelect={navigate}
              onCreateCategory={handleCreateCategory}
              onCreateProject={handleCreateProject}
              onCategoryMenu={handleCategoryMenu}
              onProjectMenu={handleProjectMenu}
              onOpenManual={() => setManualOpen(true)}
            />
          )}

          <main className="workspace">
            {selection.view === 'tasks' && (
              <TasksView
                title={viewTitle}
                scope={selection.scope}
                projectId={selection.projectId}
                categoryId={selection.categoryId}
                place={selection.place}
                onOpenTask={onOpenTask}
                focusTarget={focusTarget}
                onFocusHandled={() => setFocusTarget(null)}
                autoFocusQuickAdd={!isMobile && selection.scope === 'scheduled'}
              />
            )}
            {selection.view === 'calendar' && <CalendarView onOpenTask={onOpenTask} />}
            {selection.view === 'roadmap' && <RoadmapView onOpenTask={onOpenTask} />}
            {selection.view === 'settings' && <SettingsView onOpenManual={() => setManualOpen(true)} />}
          </main>

          {!isMobile && detailBody && (
            <aside className="panel" aria-label="Task details">
              <div className="panel__header">
                <span className="panel__title">Task details</span>
                <button type="button" className="icon-button" onClick={() => setOpenTaskId(null)} aria-label="Close panel">
                  <FiX aria-hidden="true" />
                </button>
              </div>
              <div className="panel__body">{detailBody}</div>
            </aside>
          )}
        </div>

        {isMobile && (
          <>
            <button type="button" className="fab" onClick={() => setMobileCreateOpen(true)} aria-label="Add task">
              <FiPlus aria-hidden="true" />
            </button>

            <nav className="tabbar" aria-label="Views">
              {(['tasks', 'calendar', 'roadmap', 'settings'] as ViewKey[]).map((key) => {
                const Icon = TAB_ICONS[key];
                return (
                  <button
                    key={key}
                    type="button"
                    className={`tabbar__item${selection.view === key ? ' tabbar__item--active' : ''}`}
                    onClick={() => setSelection((prev) => ({ ...prev, view: key }))}
                  >
                    <span className="tabbar__icon" aria-hidden="true">
                      <Icon />
                    </span>
                    {TAB_LABELS[key]}
                  </button>
                );
              })}
            </nav>
          </>
        )}

        {isMobile && (
          <BottomSheet open={mobileCreateOpen} title="New task" onClose={() => setMobileCreateOpen(false)}>
            <div className="sheet-create">
              <QuickAdd
                autoFocus
                onSubmitted={() => setMobileCreateOpen(false)}
                placeholder="What needs doing? Add @place, !1, #Project…"
              />
              <p className="muted">
                Type <code>#</code> for projects, <code>^</code> for categories, <code>@</code> for places
                and <code>!</code> for priority.
              </p>
            </div>
          </BottomSheet>
        )}

        {isMobile && (
          <BottomSheet open={!!detailBody} title="Task details" onClose={() => setOpenTaskId(null)}>
            {detailBody}
          </BottomSheet>
        )}

        {isMobile ? (
          <BottomSheet open={manualOpen} title="User manual" onClose={() => setManualOpen(false)}>
            <UserManual />
          </BottomSheet>
        ) : (
          manualOpen && (
            <div className="modal-backdrop" onClick={() => setManualOpen(false)} role="presentation">
              <div
                className="modal"
                onClick={(event) => event.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label="User manual"
              >
                <header className="modal__header">
                  <span className="modal__title">User manual</span>
                  <button type="button" className="icon-button" onClick={() => setManualOpen(false)} aria-label="Close manual">
                    <FiX aria-hidden="true" />
                  </button>
                </header>
                <div className="modal__body">
                  <UserManual />
                </div>
              </div>
            </div>
          )
        )}
      </div>
    </CelebrationProvider>
  );
}
