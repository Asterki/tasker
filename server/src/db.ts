/**
 * SQLite persistence for the sync relay.
 *
 * The relay is intentionally dumb: it authenticates a key, appends change
 * records to a per-user log, and keeps a materialised "latest" row per entity
 * so a new device can bootstrap from a snapshot. All merging happens on the
 * client, so payloads can stay encrypted.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const databasePath = process.env.DB_PATH
  ? resolve(process.env.DB_PATH)
  : resolve(process.cwd(), 'data', 'tasker.db');

mkdirSync(dirname(databasePath), { recursive: true });

export const db = new Database(databasePath);

db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = OFF');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    key_hash   TEXT PRIMARY KEY,
    head_seq   INTEGER NOT NULL DEFAULT 0,
    min_seq    INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS changes (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL,
    change_id   TEXT NOT NULL,
    client_id   TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id   TEXT NOT NULL,
    hlc         TEXT NOT NULL,
    deleted     INTEGER NOT NULL,
    payload     TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    UNIQUE (user_id, change_id)
  );

  CREATE INDEX IF NOT EXISTS changes_pull ON changes (user_id, seq);

  CREATE TABLE IF NOT EXISTS entities (
    user_id     TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id   TEXT NOT NULL,
    hlc         TEXT NOT NULL,
    deleted     INTEGER NOT NULL,
    payload     TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    PRIMARY KEY (user_id, entity_type, entity_id)
  );

  CREATE INDEX IF NOT EXISTS entities_snapshot
    ON entities (user_id, entity_type, entity_id);
`);

export interface UserRow {
  key_hash: string;
  head_seq: number;
  min_seq: number;
  created_at: number;
}

export interface ChangeInput {
  changeId: string;
  clientId: string;
  entityType: string;
  entityId: string;
  hlc: string;
  deleted: boolean;
  payload: string;
}

export interface StoredChange {
  seq: number;
  change_id: string;
  client_id: string;
  entity_type: string;
  entity_id: string;
  hlc: string;
  deleted: number;
  payload: string;
}

export interface StoredEntity {
  entity_type: string;
  entity_id: string;
  hlc: string;
  deleted: number;
  payload: string;
}

export const ENTITY_TYPES = ['task', 'category', 'project', 'place', 'settings'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

const insertUser = db.prepare(
  'INSERT OR IGNORE INTO users (key_hash, created_at) VALUES (?, ?)',
);
const selectUser = db.prepare('SELECT * FROM users WHERE key_hash = ?');

/** Looks up an existing sync space without creating one. */
export function findUser(keyHash: string): UserRow | null {
  return (selectUser.get(keyHash) as UserRow | undefined) ?? null;
}

/** Resolves a bearer key to a user row, creating the row on first contact. */
export function resolveUser(keyHash: string): UserRow {
  insertUser.run(keyHash, Date.now());
  return selectUser.get(keyHash) as UserRow;
}

const insertChange = db.prepare(`
  INSERT INTO changes
    (user_id, change_id, client_id, entity_type, entity_id, hlc, deleted, payload, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (user_id, change_id) DO NOTHING
  RETURNING seq
`);

const upsertEntity = db.prepare(`
  INSERT INTO entities (user_id, entity_type, entity_id, hlc, deleted, payload, seq)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (user_id, entity_type, entity_id) DO UPDATE SET
    hlc = excluded.hlc,
    deleted = excluded.deleted,
    payload = excluded.payload,
    seq = excluded.seq
  WHERE excluded.hlc > entities.hlc
`);

const bumpHead = db.prepare('UPDATE users SET head_seq = MAX(head_seq, ?) WHERE key_hash = ?');

export interface PushResult {
  accepted: string[];
  cursor: number;
}

/** Appends a batch atomically. Duplicate change ids are ignored. */
export const pushChanges = db.transaction(
  (userId: string, changes: ChangeInput[]): PushResult => {
    const accepted: string[] = [];
    let cursor = 0;

    for (const change of changes) {
      const row = insertChange.get(
        userId,
        change.changeId,
        change.clientId,
        change.entityType,
        change.entityId,
        change.hlc,
        change.deleted ? 1 : 0,
        change.payload,
        Date.now(),
      ) as { seq: number } | undefined;

      if (!row) continue;

      accepted.push(change.changeId);
      cursor = row.seq;
      upsertEntity.run(
        userId,
        change.entityType,
        change.entityId,
        change.hlc,
        change.deleted ? 1 : 0,
        change.payload,
        row.seq,
      );
    }

    if (cursor > 0) bumpHead.run(cursor, userId);
    return { accepted, cursor };
  },
);

export function currentHead(userId: string): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM changes WHERE user_id = ?')
    .get(userId) as { seq: number };
  return row.seq;
}

export function pullChanges(
  userId: string,
  since: number,
  limit: number,
): { changes: StoredChange[]; cursor: number; hasMore: boolean } {
  const rows = db
    .prepare(
      'SELECT * FROM changes WHERE user_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
    )
    .all(userId, since, limit + 1) as StoredChange[];

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const cursor = page.length > 0 ? page[page.length - 1].seq : since;

  return { changes: page, cursor, hasMore };
}

export function snapshot(
  userId: string,
  head: number,
  after: { type: string; id: string } | null,
  limit: number,
): { entities: StoredEntity[]; next: { type: string; id: string } | null } {
  const rows = (
    after
      ? db
          .prepare(
            `SELECT entity_type, entity_id, hlc, deleted, payload
             FROM entities
             WHERE user_id = ? AND seq <= ?
               AND (entity_type > ? OR (entity_type = ? AND entity_id > ?))
             ORDER BY entity_type ASC, entity_id ASC
             LIMIT ?`,
          )
          .all(userId, head, after.type, after.type, after.id, limit + 1)
      : db
          .prepare(
            `SELECT entity_type, entity_id, hlc, deleted, payload
             FROM entities
             WHERE user_id = ? AND seq <= ?
             ORDER BY entity_type ASC, entity_id ASC
             LIMIT ?`,
          )
          .all(userId, head, limit + 1)
  ) as StoredEntity[];

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return {
    entities: page,
    next: hasMore && last ? { type: last.entity_type, id: last.entity_id } : null,
  };
}

/**
 * Drops change-log rows older than the retention window. Clients whose cursor
 * falls behind the new floor are told to resync from a snapshot.
 */
export function purgeOldChanges(retentionDays: number): void {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const rows = db
    .prepare(
      'SELECT user_id, MAX(seq) AS maxSeq FROM changes WHERE created_at < ? GROUP BY user_id',
    )
    .all(cutoff) as { user_id: string; maxSeq: number }[];

  if (rows.length === 0) return;

  const remove = db.prepare('DELETE FROM changes WHERE user_id = ? AND created_at < ?');
  const floor = db.prepare('UPDATE users SET min_seq = MAX(min_seq, ?) WHERE key_hash = ?');

  db.transaction(() => {
    for (const row of rows) {
      remove.run(row.user_id, cutoff);
      floor.run(row.maxSeq, row.user_id);
    }
  })();
}
