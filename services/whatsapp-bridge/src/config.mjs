import path from 'node:path';

export function phoneNumber(value) {
  if (typeof value !== 'string' || !/^\+?[1-9][0-9]{7,14}$/.test(value)) return null;
  return value.replace(/^\+/, '');
}

export function loadConfig(env, serviceDirectory) {
  const botNumber = phoneNumber(env.TEAM_CHAT_BOT_NUMBER);
  if (!botNumber) throw new Error('invalid_bot_number');
  const allowedNumbers = new Set();
  for (const item of (env.TEAM_CHAT_ALLOWED_NUMBERS || '').split(',').filter(Boolean)) {
    const number = phoneNumber(item.trim());
    if (!number || number === botNumber) throw new Error('invalid_allowed_number');
    allowedNumbers.add(number);
  }
  if (allowedNumbers.size === 0 || allowedNumbers.size > 100) throw new Error('invalid_sender_allowlist');
  const allowedGroups = new Set();
  for (const item of (env.TEAM_CHAT_ALLOWED_GROUPS || '').split(',').filter(Boolean)) {
    const group = item.trim();
    if (!/^[0-9]+(?:-[0-9]+)?@g\.us$/.test(group) || group.length > 100) throw new Error('invalid_group_allowlist');
    allowedGroups.add(group);
  }
  if (allowedGroups.size > 20) throw new Error('invalid_group_allowlist');
  const key = env.TEAM_CHAT_SHARED_KEY || '';
  if (!/^[0-9a-fA-F]{64}$/.test(key) || /^0+$/.test(key)) throw new Error('invalid_shared_key');
  let url;
  try { url = new URL(env.TEAM_CHAT_BACKEND_URL); } catch { throw new Error('invalid_backend_url'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.pathname !== '/api/whatsapp/team-chat' || (url.port && url.port !== '443')) {
    throw new Error('invalid_backend_url');
  }
  const configuredDirectory = env.TEAM_CHAT_STATE_DIR || '';
  if (!path.isAbsolute(configuredDirectory)) throw new Error('state_directory_must_be_absolute');
  const stateDirectory = path.resolve(configuredDirectory);
  const relative = path.relative(path.resolve(serviceDirectory, '../..'), stateDirectory);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('state_directory_must_be_outside_repository');
  }
  if (stateDirectory === path.parse(stateDirectory).root || /(?:^|[\\/])(?:public_html|htdocs|wwwroot)(?:[\\/]|$)/i.test(stateDirectory)) {
    throw new Error('state_directory_must_be_private');
  }
  return { botNumber, allowedNumbers, allowedGroups, key, backendUrl: url.href, stateDirectory,
    allowPairing: env.TEAM_CHAT_PAIR === '1' };
}
