/**
 * Settings — appearance, progress, workspace and data.
 */

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { FiBell, FiLock, FiTrendingUp } from 'react-icons/fi';
import type { BackupFile, Category, NotificationSettings, Settings } from '../domain/types';
import {
  deviceTimezone,
  formatDateShort,
  formatInTimezone,
  formatTime,
  isValidTimezone,
  todayISO,
} from '../domain/date';
import { completionsByDay, currentStreak, levelForXp, ACHIEVEMENTS } from '../domain/progress';
import { CATEGORY_COLORS, useTasker } from '../state/store';
import {
  connectSync,
  disconnectSync,
  getSyncInfo,
  getSyncStatus,
  subscribeSync,
  syncNow,
} from '../sync/engine';
import { NewSyncSpaceError, type SyncInfo, type SyncStatus } from '../sync/types';
import {
  getNotificationStatus,
  subscribeNotifications,
  syncNotificationsNow,
  testNotification,
  type NotificationStatus,
} from '../notifications/engine';
import { allDaySlots } from '../notifications/schedule';
import { isValidTopic, normalizeNtfyUrl } from '../notifications/ntfy';

interface SettingsViewProps {
  onOpenManual: () => void;
}

type Status = { tone: 'ok' | 'warn' | 'error'; text: string } | null;

export function SettingsView({ onOpenManual }: SettingsViewProps) {
  const {
    settings,
    categories,
    projects,
    tasks,
    places,
    updateSettings,
    createCategory,
    updateCategory,
    deleteCategory,
    buildBackup,
    restoreBackup,
    resetEverything,
  } = useTasker();

  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const [syncStatus, setSyncStatus] = useState<SyncStatus>(getSyncStatus);
  const [syncInfo, setSyncInfo] = useState<SyncInfo | null>(null);
  const [serverUrl, setServerUrl] = useState(
    import.meta.env.VITE_SYNC_URL ?? 'https://tasker-api.asterki.xyz',
  );
  const [passphrase, setPassphrase] = useState('');
  const [syncBusy, setSyncBusy] = useState(false);
  const [confirmCreate, setConfirmCreate] = useState(false);

  const [notifyStatus, setNotifyStatus] = useState<NotificationStatus>(getNotificationStatus);
  const [notifyBusy, setNotifyBusy] = useState(false);

  useEffect(() => {
    const unsubscribe = subscribeSync(setSyncStatus);
    void getSyncInfo().then(setSyncInfo);
    return unsubscribe;
  }, []);

  useEffect(() => subscribeNotifications(setNotifyStatus), []);

  const timezones = useMemo(() => {
    const fallback = [
      'UTC',
      'America/New_York',
      'America/Chicago',
      'America/Denver',
      'America/Los_Angeles',
      'America/Mexico_City',
      'Europe/London',
      'Europe/Berlin',
      'Europe/Madrid',
      'Asia/Tokyo',
      'Asia/Kolkata',
      'Australia/Sydney',
    ];
    let supported: string[] = [];
    try {
      supported =
        (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.(
          'timeZone',
        ) ?? [];
    } catch {
      /* older browser: use the short list */
    }
    return [...new Set([deviceTimezone(), 'UTC', ...(supported.length > 0 ? supported : fallback)])].sort();
  }, []);

  const timezoneValid = isValidTimezone(settings.timezone);
  const allDayTimes = allDaySlots(settings.notifications.allDayCount);
  const notificationTargetValid =
    Boolean(normalizeNtfyUrl(settings.notifications.serverUrl)) &&
    isValidTopic(settings.notifications.topic);

  function patchNotifications(partial: Partial<NotificationSettings>) {
    updateSettings({ notifications: { ...settings.notifications, ...partial } });
  }

  async function handleTestNotification() {
    setNotifyBusy(true);
    try {
      await testNotification(settings);
      setStatus({
        tone: 'ok',
        text: 'Test notification published. Check the ntfy app subscribed to your topic.',
      });
    } catch (error) {
      setStatus({
        tone: 'error',
        text: error instanceof Error ? error.message : 'Could not send the test notification.',
      });
    } finally {
      setNotifyBusy(false);
    }
  }

  async function handleRefreshNotifications() {
    setNotifyBusy(true);
    await syncNotificationsNow(settings, tasks, projects);
    const next = getNotificationStatus();
    setNotifyBusy(false);
    setStatus(
      next.error
        ? { tone: 'error', text: next.error }
        : {
            tone: 'ok',
            text: `Reminder schedule refreshed · ${next.scheduled} armed for the next two days.`,
          },
    );
  }

  const handleConnect = async (allowCreate: boolean) => {
    setSyncBusy(true);
    try {
      const result = await connectSync(serverUrl, passphrase, allowCreate);
      setSyncInfo(await getSyncInfo());
      setPassphrase('');
      setConfirmCreate(false);
      setStatus({
        tone: 'ok',
        text: result.created ? 'New sync space created and linked.' : 'Connected. Your tasks are syncing.',
      });
    } catch (error) {
      if (error instanceof NewSyncSpaceError) {
        setConfirmCreate(true);
        setStatus({
          tone: 'warn',
          text: 'This passphrase has no data on the relay yet. Create a space to start syncing with it.',
        });
      } else {
        setStatus({
          tone: 'error',
          text: error instanceof Error ? error.message : 'Could not connect.',
        });
      }
    } finally {
      setSyncBusy(false);
    }
  };

  const handleDisconnect = async () => {
    setSyncBusy(true);
    try {
      await disconnectSync();
      setSyncInfo(null);
      setConfirmCreate(false);
      setStatus({ tone: 'ok', text: 'Sync disconnected. Local data is untouched.' });
    } finally {
      setSyncBusy(false);
    }
  };

  const patch = (partial: Partial<Settings>) => updateSettings(partial);

  const progress = settings.progress;
  const level = levelForXp(progress.xp);
  const streak = currentStreak(progress);
  const doneToday = progress.todayDate === todayISO() ? progress.todayCount : 0;
  const history = useMemo(() => completionsByDay(tasks, 14), [tasks]);
  const peak = Math.max(1, ...history.map((day) => day.count));
  const plannedToday = tasks.filter((task) => !task.completed && task.date === todayISO() && task.parentId === null).length;

  function handleExport() {
    const backup = buildBackup();
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `tasker-backup-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus({
      tone: 'ok',
      text: `Exported ${backup.tasks.length} tasks, ${backup.projects.length} projects and ${backup.categories.length} categories.`,
    });
  }

  async function handleImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const parsed = JSON.parse(await file.text()) as BackupFile;
      await restoreBackup(parsed);
      setStatus({ tone: 'ok', text: `Restored ${parsed.tasks?.length ?? 0} tasks.` });
    } catch (error) {
      setStatus({ tone: 'error', text: `Import failed: ${(error as Error).message}` });
    }
    setBusy(false);
  }

  async function handleReset() {
    if (!window.confirm('Erase every task, project, category and setting on this device?')) return;
    setBusy(true);
    await resetEverything();
    setStatus({ tone: 'ok', text: 'All local data was erased.' });
    setBusy(false);
  }

  function handleCategoryMenu(category: Category) {
    const choice = window.prompt(
      `“${category.name}”\n\n1 — Rename\n2 — Change colour\n3 — Delete\n\nEnter a number:`,
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
      }
    }
  }

  return (
    <section className="view">
      <header className="view__header">
        <div>
          <h1 className="view__title">Settings</h1>
          <p className="view__subtitle">Appearance, progress, workspace and data</p>
        </div>
        <button type="button" className="button" onClick={onOpenManual}>
          Open user manual
        </button>
      </header>

      {status && <div className={`notice notice--${status.tone}`}>{status.text}</div>}

      <div className="card">
        <h2 className="card__title">Progress</h2>
        <div className="progress-head">
          <div className="progress-level">
            <span className="progress-level__badge">{level.level}</span>
            <div>
              <strong>Level {level.level}</strong>
              <span className="muted">
                {level.into} / {level.needed} XP to level {level.level + 1}
              </span>
            </div>
          </div>
          <div className="progress-bar" aria-hidden="true">
            <span className="progress-bar__fill" style={{ width: `${Math.round(level.ratio * 100)}%` }} />
          </div>
        </div>

        <div className="stats">
          <span className="stat">
            <strong>{doneToday}</strong> done today
            {plannedToday > 0 && <span className="muted"> / {plannedToday} planned</span>}
          </span>
          <span className="stat">
            <strong>
              <FiTrendingUp aria-hidden="true" /> {streak}
            </strong>{' '}
            day streak
          </span>
          <span className="stat">
            <strong>{progress.bestStreak}</strong> best streak
          </span>
          <span className="stat">
            <strong>{progress.totalCompleted}</strong> completed all time
          </span>
          <span className="stat">
            <strong>{progress.xp}</strong> XP
          </span>
        </div>

        <div className="settings-chart" aria-label="Completions over the last 14 days">
          {history.map((day) => (
            <span
              key={day.date}
              className={`settings-chart__col${day.count > 0 ? ' settings-chart__col--filled' : ''}`}
              title={`${formatDateShort(day.date)} · ${day.count}`}
            >
              <span style={{ height: `${Math.max(4, (day.count / peak) * 100)}%` }} />
            </span>
          ))}
        </div>

        <div className="card__row">
          <label className="switch switch--boxed">
            <input
              type="checkbox"
              checked={settings.soundEnabled}
              onChange={(event) => patch({ soundEnabled: event.target.checked })}
            />
            <span>Completion chime</span>
          </label>
          <label className="switch switch--boxed">
            <input
              type="checkbox"
              checked={settings.hapticsEnabled}
              onChange={(event) => patch({ hapticsEnabled: event.target.checked })}
            />
            <span>Haptic feedback</span>
          </label>
          <label className="field">
            <span className="field__label">Theme</span>
            <select
              className="input"
              value={settings.theme}
              onChange={(event) => patch({ theme: event.target.value as Settings['theme'] })}
            >
              <option value="nordic-light">GitHub Light</option>
              <option value="nordic-dark">GitHub Dark</option>
            </select>
          </label>
        </div>

        <div className="hud__achievements">
          <span className="hud__section-title">
            Achievements
            <span className="hud__muted">
              {progress.unlocked.length}/{ACHIEVEMENTS.length}
            </span>
          </span>
          <div className="badge-grid">
            {ACHIEVEMENTS.map((achievement) => {
              const owned = progress.unlocked.includes(achievement.id);
              return (
                <span
                  key={achievement.id}
                  className={`badge${owned ? ' badge--owned' : ''}`}
                  title={achievement.description}
                >
                  <span aria-hidden="true">{owned ? achievement.icon : <FiLock />}</span>
                  {achievement.title}
                </span>
              );
            })}
          </div>
        </div>
      </div>

      <div className="card">
        <h2 className="card__title">Categories &amp; projects</h2>
        <p className="card__hint">
          Categories group projects; projects group tasks. Every task can nest subtasks to any depth.
        </p>
        {categories.length === 0 && <p className="muted">No categories yet.</p>}
        <ul className="settings-list">
          {categories.map((category) => (
            <li key={category.id} className="settings-list__row">
              <span className="dot" style={{ background: category.color }} />
              <span className="settings-list__label">{category.name}</span>
              <span className="muted">
                {projects.filter((project) => project.categoryId === category.id).length} projects
              </span>
              <button type="button" className="link-button" onClick={() => handleCategoryMenu(category)}>
                manage
              </button>
            </li>
          ))}
        </ul>
        <div className="card__actions">
          <button
            type="button"
            className="button"
            onClick={() => {
              const name = window.prompt('Category name — e.g. Work, Personal');
              if (name?.trim()) createCategory(name.trim());
            }}
          >
            New category
          </button>
        </div>
      </div>

      <div className="card">
        <h2 className="card__title">Data</h2>
        <p className="card__hint">
          Everything is stored locally in IndexedDB. Export a JSON snapshot to back up, import it to
          restore. Import replaces the current state.
        </p>
        <div className="stats">
          <span className="stat">
            <strong>{tasks.length}</strong> tasks
          </span>
          <span className="stat">
            <strong>{projects.length}</strong> projects
          </span>
          <span className="stat">
            <strong>{categories.length}</strong> categories
          </span>
          <span className="stat">
            <strong>{places.length}</strong> places
          </span>
        </div>
        <div className="card__actions">
          <button type="button" className="button button--primary" onClick={handleExport}>
            Export JSON
          </button>
          <button type="button" className="button" onClick={() => fileInput.current?.click()} disabled={busy}>
            Import JSON
          </button>
          <button type="button" className="button button--danger" onClick={() => void handleReset()} disabled={busy}>
            Reset app
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(event) => void handleImport(event)}
        />
      </div>

      <div className="card">
        <h2 className="card__title">Sync</h2>
        <p className="card__hint">
          Optional end-to-end encrypted sync through your own relay. Your passphrase never leaves
          this device; only ciphertext is stored on the server. Tasks, projects, settings, XP,
          streaks and achievements all follow you. Lose the passphrase and the sync space cannot
          be recovered.
        </p>

        {syncInfo ? (
          <>
            <dl className="about">
              <div>
                <dt>Relay</dt>
                <dd>{syncInfo.serverUrl}</dd>
              </div>
              <div>
                <dt>Space</dt>
                <dd className="sync-fingerprint">{syncInfo.fingerprint}</dd>
              </div>
              <div>
                <dt>Last sync</dt>
                <dd>{syncInfo.lastSyncAt ? new Date(syncInfo.lastSyncAt).toLocaleString() : 'Not yet'}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>
                  {syncStatus.state === 'syncing'
                    ? 'Syncing…'
                    : syncStatus.state === 'error'
                      ? 'Needs attention'
                      : 'Up to date'}
                  {syncStatus.pending > 0 ? ` · ${syncStatus.pending} queued` : ''}
                </dd>
              </div>
            </dl>
            {syncStatus.error && <p className="card__hint">{syncStatus.error}</p>}
            <div className="card__actions">
              <button
                type="button"
                className="button button--primary"
                onClick={() => void syncNow()}
                disabled={syncStatus.state === 'syncing'}
              >
                Sync now
              </button>
              <button
                type="button"
                className="button"
                onClick={() => void handleDisconnect()}
                disabled={syncBusy}
              >
                Disconnect
              </button>
            </div>
          </>
        ) : (
          <div className="sync-form">
            <label className="field">
              <span className="field__label">Relay URL</span>
              <input
                className="input"
                type="url"
                value={serverUrl}
                onChange={(event) => setServerUrl(event.target.value)}
                placeholder="https://tasker-api.example.com"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="field">
              <span className="field__label">Passphrase</span>
              <input
                className="input"
                type="password"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                placeholder="At least 8 characters"
                autoComplete="new-password"
              />
            </label>
            <div className="card__actions">
              <button
                type="button"
                className="button button--primary"
                onClick={() => void handleConnect(false)}
                disabled={syncBusy || passphrase.trim().length < 8}
              >
                Connect
              </button>
              {confirmCreate && (
                <button
                  type="button"
                  className="button button--danger"
                  onClick={() => void handleConnect(true)}
                  disabled={syncBusy}
                >
                  Create new space
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h2 className="card__title">
          <FiBell aria-hidden="true" /> Notifications
        </h2>
        <p className="card__hint">
          Tasker publishes reminders straight to <a href="https://ntfy.sh" target="_blank" rel="noreferrer">ntfy</a>.
          Install the ntfy app on your phone or desktop and subscribe to the same topic. Tasks with a
          time remind you at that exact time; tasks with a date but no time use the per-day schedule
          below.
        </p>

        <div className="card__row">
          <label className="switch switch--boxed">
            <input
              type="checkbox"
              checked={settings.notifications.enabled}
              onChange={(event) => patchNotifications({ enabled: event.target.checked })}
            />
            <span>Enable ntfy reminders</span>
          </label>

          <label className="field">
            <span className="field__label">Time zone</span>
            <div className="field__row">
              <input
                className="input"
                list="tasker-timezones"
                value={settings.timezone}
                onChange={(event) => updateSettings({ timezone: event.target.value })}
                placeholder="Europe/Madrid"
                spellCheck={false}
                autoComplete="off"
              />
              <button
                type="button"
                className="button"
                onClick={() => updateSettings({ timezone: deviceTimezone() })}
              >
                Device
              </button>
            </div>
            <datalist id="tasker-timezones">
              {timezones.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
            <span className="notification-hint">
              {timezoneValid
                ? `Now: ${formatInTimezone(Date.now(), settings.timezone)}`
                : 'Unknown zone — use an IANA name such as Europe/Madrid.'}
            </span>
          </label>

          <label className="field">
            <span className="field__label">All-day reminders</span>
            <select
              className="input"
              value={settings.notifications.allDayCount}
              onChange={(event) =>
                patchNotifications({ allDayCount: Number(event.target.value) })
              }
            >
              {[1, 2, 3, 4, 5].map((count) => (
                <option key={count} value={count}>
                  {count}× per day
                </option>
              ))}
            </select>
            <span className="notification-hint">At {allDayTimes.map(formatTime).join(', ')}</span>
          </label>
        </div>

        <div className="sync-form">
          <label className="field">
            <span className="field__label">ntfy server</span>
            <input
              className="input"
              type="url"
              value={settings.notifications.serverUrl}
              onChange={(event) => patchNotifications({ serverUrl: event.target.value })}
              placeholder="https://ntfy.sh"
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <label className="field">
            <span className="field__label">Topic</span>
            <input
              className="input"
              value={settings.notifications.topic}
              onChange={(event) => patchNotifications({ topic: event.target.value })}
              placeholder="tasker-8f3k2m"
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <label className="field">
            <span className="field__label">Access token · optional</span>
            <input
              className="input"
              type="password"
              value={settings.notifications.token}
              onChange={(event) => patchNotifications({ token: event.target.value })}
              placeholder="tk_…"
              autoComplete="new-password"
            />
          </label>
        </div>

        <p className="card__hint">
          The topic works like a password. Use a long random topic, or self-host ntfy and require an
          access token. Reminders are armed two days ahead and refreshed whenever Tasker opens, so
          longer-range tasks need the app to be opened occasionally. The token is included in JSON
          backups and encrypted sync.
        </p>

        <div className="notification-status">
          <span>
            {notifyStatus.state === 'scheduling'
              ? 'Scheduling reminders…'
              : notifyStatus.state === 'error'
                ? 'Reminder delivery needs attention'
                : !settings.notifications.enabled
                  ? 'Reminders are off'
                  : !notificationTargetValid
                    ? 'Add a valid ntfy server and topic to start'
                    : notifyStatus.scheduled > 0
                      ? `${notifyStatus.scheduled} reminder${notifyStatus.scheduled === 1 ? '' : 's'} armed for the next two days`
                      : 'No upcoming reminders in the next two days'}
          </span>
          {notifyStatus.lastSyncAt > 0 && (
            <span className="muted">
              Refreshed {new Date(notifyStatus.lastSyncAt).toLocaleTimeString()}
            </span>
          )}
        </div>
        {notifyStatus.error && <p className="notification-error">{notifyStatus.error}</p>}

        <div className="card__actions">
          <button
            type="button"
            className="button button--primary"
            onClick={() => void handleTestNotification()}
            disabled={notifyBusy || !notificationTargetValid}
          >
            Send test notification
          </button>
          <button
            type="button"
            className="button"
            onClick={() => void handleRefreshNotifications()}
            disabled={notifyBusy}
          >
            Refresh schedule
          </button>
        </div>
      </div>

      <div className="card">
        <h2 className="card__title">About</h2>
        <dl className="about">
          <div>
            <dt>Version</dt>
            <dd>{__APP_VERSION__}</dd>
          </div>
          <div>
            <dt>Build mode</dt>
            <dd>{__APP_MODE__}</dd>
          </div>
          <div>
            <dt>Built</dt>
            <dd>{new Date(__BUILD_TIME__).toLocaleString()}</dd>
          </div>
          <div>
            <dt>Storage</dt>
            <dd>IndexedDB (local-first)</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
