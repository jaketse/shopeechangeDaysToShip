import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

const dbPath = path.join(os.homedir(), '.shopee-days-to-ship-electron.sqlite');
let db;
let txDepth = 0;

function isWriteSql(sql) {
  return /^\s*(insert|update|delete|create|drop|alter|replace|begin|commit|rollback)/i.test(sql);
}

function wrapPrepare(sql) {
  return {
    run: (...params) => {
      const stmt = db.prepare(sql);
      const info = stmt.run(...params);
      const lastInsertRowid = Number(info?.lastInsertRowid || 0);
      return { lastInsertRowid };
    },
    get: (...params) => {
      const stmt = db.prepare(sql);
      return stmt.get(...params);
    },
    all: (...params) => {
      const stmt = db.prepare(sql);
      return stmt.all(...params);
    },
  };
}

export async function initDB() {
  if (db) return;
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL UNIQUE,
      shop_name TEXT,
      cookie_json TEXT NOT NULL,
      created_at INTEGER,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      name TEXT,
      image TEXT,
      price TEXT,
      stock INTEGER,
      days_to_ship INTEGER,
      status INTEGER,
      is_pre_order INTEGER,
      detail_json TEXT,
      fetched_at INTEGER,
      in_change_list INTEGER DEFAULT 0,
      exists_in_latest INTEGER DEFAULT 1,
      UNIQUE(account_id, product_id)
    );

    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      tab TEXT,
      message TEXT,
      type TEXT,
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS task_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      task_type TEXT NOT NULL,
      payload_json TEXT,
      status TEXT NOT NULL,
      created_at INTEGER,
      updated_at INTEGER,
      last_error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_products_account_change_list
      ON products(account_id, in_change_list);
    CREATE INDEX IF NOT EXISTS idx_products_account_latest
      ON products(account_id, exists_in_latest);
    CREATE INDEX IF NOT EXISTS idx_logs_account_tab_created
      ON logs(account_id, tab, created_at);
    CREATE INDEX IF NOT EXISTS idx_task_queue_account_type_status_created
      ON task_queue(account_id, task_type, status, created_at);
  `);
}

export const dbApi = {
  prepare: (sql) => wrapPrepare(sql),
  exec: (sql) => {
    db.exec(sql);
  },
  transaction: (fn) => (...args) => {
    txDepth += 1;
    try {
      const wrapped = db.transaction(() => fn(...args));
      wrapped();
      txDepth -= 1;
    } catch (e) {
      txDepth = Math.max(0, txDepth - 1);
      throw e;
    }
  },
};
