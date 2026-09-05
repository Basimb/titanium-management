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
  const runtime = createBridgeRuntime({
    config, store, auth, makeWASocket, jidNormalizedUser, makeCacheableSignalKeyStore, DisconnectReason, logger,
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
