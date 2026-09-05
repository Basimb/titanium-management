import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export function openStore(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('invalid_state_directory');
  const file = join(directory, 'bridge.sqlite');
  try { if (lstatSync(file).isSymbolicLink()) throw new Error('invalid_state_file'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const db = new DatabaseSync(file);
  if (process.platform !== 'win32') { chmodSync(directory, 0o700); chmodSync(file, 0o600); }
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS auth (category TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(category,id));
    CREATE TABLE IF NOT EXISTS inbox (
      id TEXT PRIMARY KEY, chat_jid TEXT NOT NULL, raw_body TEXT NOT NULL, sender TEXT NOT NULL,
      created_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'backend', next_at INTEGER NOT NULL DEFAULT 0,
      backend_attempts INTEGER NOT NULL DEFAULT 0, reply_attempts INTEGER NOT NULL DEFAULT 0,
      reply TEXT, reply_id TEXT NOT NULL, result TEXT, error_code TEXT
    );
    CREATE INDEX IF NOT EXISTS inbox_pending ON inbox(state,next_at);
    CREATE INDEX IF NOT EXISTS inbox_sender ON inbox(sender,created_at);`);
  // Crash recovery reuses the SAME request body and reply message ID.
  db.exec("UPDATE inbox SET state='reply' WHERE state='sending_reply'");
  const getAuth = db.prepare('SELECT value FROM auth WHERE category=? AND id=?');
  const putAuth = db.prepare('INSERT INTO auth(category,id,value) VALUES(?,?,?) ON CONFLICT(category,id) DO UPDATE SET value=excluded.value');
  const delAuth = db.prepare('DELETE FROM auth WHERE category=? AND id=?');
  return {
    db,
    close: () => db.close(),
    authGet: (category, id) => getAuth.get(category, id)?.value,
    authPut: (category, id, value) => putAuth.run(category, id, value),
    authDelete: (category, id) => delAuth.run(category, id),
    transaction(work) {
      db.exec('BEGIN IMMEDIATE');
      try { const result = work(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    activate(now) {
      db.prepare("INSERT OR IGNORE INTO meta(name,value) VALUES('activated_at',?)").run(String(now));
      return Number(db.prepare("SELECT value FROM meta WHERE name='activated_at'").get().value);
    },
    bindAccount(number) {
      db.prepare("INSERT OR IGNORE INTO meta(name,value) VALUES('account_number',?)").run(number);
      if (db.prepare("SELECT value FROM meta WHERE name='account_number'").get().value !== number) {
        throw new Error('state_belongs_to_another_account');
      }
    },
    enqueue({ chatJid, body }) {
      const id = createHash('sha256').update(JSON.stringify([body.groupId, body.senderNumber, body.messageId])).digest('hex');
      const existing = db.prepare('SELECT id FROM inbox WHERE id=?').get(id);
      if (existing) return false;
      const recent = db.prepare('SELECT count(*) AS count FROM inbox WHERE sender=? AND created_at>?').get(body.senderNumber, body.receivedAt - 60_000).count;
      const pending = db.prepare("SELECT count(*) AS count FROM inbox WHERE state IN ('backend','reply','sending_reply')").get().count;
      if (recent >= 12 || pending >= 1000) return false;
      const replyId = randomBytes(18).toString('hex').toUpperCase();
      db.prepare('INSERT INTO inbox(id,chat_jid,raw_body,sender,created_at,reply_id) VALUES(?,?,?,?,?,?)')
        .run(id, chatJid, JSON.stringify({ ...body, responseMessageId: replyId }), body.senderNumber, body.receivedAt, replyId);
      return true;
    },
    next(now) { return db.prepare("SELECT * FROM inbox WHERE state IN ('backend','reply') AND next_at<=? ORDER BY created_at,id LIMIT 1").get(now); },
    outgoingMessage(key) {
      if (!key?.id || !key.remoteJid) return undefined;
      const row = db.prepare('SELECT reply FROM inbox WHERE reply_id=? AND chat_jid=?').get(key.id, key.remoteJid);
      return row?.reply ? { conversation: row.reply } : undefined;
    },
    attemptBackend(id) { db.prepare('UPDATE inbox SET backend_attempts=backend_attempts+1 WHERE id=?').run(id); },
    backendResult(id, result) {
      db.prepare('UPDATE inbox SET state=?,reply=?,result=?,next_at=0,error_code=NULL WHERE id=?')
        .run(result.reply ? 'reply' : 'done', result.reply, JSON.stringify(result), id);
    },
    attemptReply(id) { db.prepare("UPDATE inbox SET state='sending_reply',reply_attempts=reply_attempts+1 WHERE id=?").run(id); },
    retry(id, state, nextAt, reason) { db.prepare('UPDATE inbox SET state=?,next_at=?,error_code=? WHERE id=?').run(state, nextAt, reason, id); },
    fail(id, reason) { db.prepare("UPDATE inbox SET state='failed',error_code=? WHERE id=?").run(reason, id); },
    done(id) { db.prepare("UPDATE inbox SET state='done',error_code=NULL WHERE id=?").run(id); },
  };
}

export function createAuthState(store, { BufferJSON, initAuthCreds, proto }) {
  const saved = store.authGet('creds', 'current');
  const creds = saved ? JSON.parse(saved, BufferJSON.reviver) : initAuthCreds();
  const saveCreds = async update => {
    Object.assign(creds, update || {});
    store.authPut('creds', 'current', JSON.stringify(creds, BufferJSON.replacer));
  };
  // Persist a newly generated identity before the first connection attempt.
  if (!saved) store.authPut('creds', 'current', JSON.stringify(creds, BufferJSON.replacer));
  return {
    state: {
      creds,
      keys: {
        async get(category, ids) {
          const output = Object.create(null);
          for (const id of ids) {
            const saved = store.authGet(category, id);
            if (!saved) continue;
            let value = JSON.parse(saved, BufferJSON.reviver);
            if (category === 'app-state-sync-key') {
              const Type = proto.Message.AppStateSyncKeyData;
              value = typeof Type.fromObject === 'function' ? Type.fromObject(value) : Type.create(value);
            }
            output[id] = value;
          }
          return output;
        },
        async set(data) {
          store.transaction(() => {
            for (const [category, records] of Object.entries(data)) {
              for (const [id, value] of Object.entries(records || {})) {
                if (value == null) store.authDelete(category, id);
                else store.authPut(category, id, JSON.stringify(value, BufferJSON.replacer));
              }
            }
          });
        },
      },
    },
    saveCreds,
  };
}
