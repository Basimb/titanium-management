import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { openStore, createAuthState } from './store.mjs';
import { createBridgeRuntime } from './runtime.mjs';

async function main() {
  if (process.env.TEAM_CHAT_BRIDGE_ENABLED !== '1') {
    console.info('Titanium bridge is disabled; no WhatsApp connection was started.');
    return;
  }
  const config = loadConfig(process.env, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const { default: makeWASocket, BufferJSON, initAuthCreds, proto, jidNormalizedUser, makeCacheableSignalKeyStore, DisconnectReason } = await import('baileys');
  const { default: pino } = await import('pino');
  const logger = pino({ level: 'silent' });
  process.umask(0o077);
  const store = openStore(config.stateDirectory);
  const auth = createAuthState(store, { BufferJSON, initAuthCreds, proto });
  let otpQueue;
  if (['1', 'pilot'].includes(process.env.WHATSAPP_LOGIN_ENABLED)) {
    const { DatabaseSync } = await import('node:sqlite');
    const { createWhatsAppLoginQueue } = await import('../../../lib/whatsapp-login-queue.ts');
    const { lstatSync, realpathSync } = await import('node:fs');
    const filename = process.env.WHATSAPP_LOGIN_DATABASE;
    if (!filename || !path.isAbsolute(filename) || realpathSync(filename) !== filename ||
      !lstatSync(filename).isFile() || lstatSync(filename).isSymbolicLink()) throw new Error('Invalid login database.');
    const otpDatabase = new DatabaseSync(filename);
    otpDatabase.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    const contacts = JSON.parse(process.env.WHATSAPP_LOGIN_CONTACTS_JSON);
    otpQueue = createWhatsAppLoginQueue({ db: otpDatabase,
      secret: Buffer.from(process.env.WHATSAPP_LOGIN_SECRET, 'hex'), contacts: () => contacts });
  }
  const runtime = createBridgeRuntime({
    config, store, auth, makeWASocket, jidNormalizedUser, makeCacheableSignalKeyStore, DisconnectReason, logger, otpQueue,
    onStop: code => { process.exitCode = code === 'service_shutdown' ? 0 : 78; },
  });
  process.once('SIGTERM', () => runtime.stop('service_shutdown'));
  process.once('SIGINT', () => runtime.stop('service_shutdown'));
  await runtime.start();
}

main().catch(() => {
  console.error('Titanium bridge could not start. Check configuration, dependency compatibility, and private storage.');
  process.exitCode = 78;
});
