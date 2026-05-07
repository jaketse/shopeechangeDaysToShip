import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import initSqlJs from 'sql.js';

const dbPath = path.join(os.homedir(), '.shopee-days-to-ship-electron.db');
let db;
let SQL;
let txDepth = 0;

function persist() {
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

function isWriteSql(sql) {
  return /^\s*(insert|update|delete|create|drop|alter|replace|begin|commit|rollback)/i.test(sql);
}

function wrapPrepare(sql) {
  return {
    run: (...params) => {
      const stmt = db.prepare(sql);
      stmt.bind(params);
      stmt.step();
      stmt.free();
      if (isWriteSql(sql) && txDepth === 0) persist();
      const idRes = db.exec('SELECT last_insert_rowid() AS id');
      const lastInsertRowid = idRes?.[0]?.values?.[0]?.[0] ?? 0;
      return { lastInsertRowid };
    },
    get: (...params) => {
      const stmt = db.prepare(sql);
      stmt.bind(params);
      const row = stmt.step() ? stmt.getAsObject() : undefined;
      stmt.free();
      return row;
    },
    all: (...params) => {
      const stmt = db.prepare(sql);
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    },
  };
}

export async function initDB() {
  if (db) return;
  SQL = await initSqlJs({ locateFile: (file) => path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', file) });
  if (fs.existsSync(dbPath)) {
    db = new SQL.Database(fs.readFileSync(dbPath));
  } else {
    db = new SQL.Database();
  }

  db.run(`
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
  persist();
}

export const dbApi = {
  prepare: (sql) => wrapPrepare(sql),
  exec: (sql) => {
    db.run(sql);
    if (isWriteSql(sql) && txDepth === 0) persist();
  },
  transaction: (fn) => (...args) => {
    txDepth += 1;
    db.run('BEGIN');
    try {
      fn(...args);
      db.run('COMMIT');
      txDepth -= 1;
      if (txDepth === 0) persist();
    } catch (e) {
      txDepth = Math.max(0, txDepth - 1);
      try {
        db.run('ROLLBACK');
      } catch {
        // ignore rollback secondary error when transaction already closed
      }
      throw e;
    }
  },
};
