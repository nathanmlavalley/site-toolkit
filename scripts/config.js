#!/usr/bin/env node
/*
 * config.js: read one site.config.json and resolve everything a deploy needs.
 *
 *   node config.js --config path/to/site.config.json --shell
 *
 * Prints shell assignments for deploy-ftp.sh to eval. Credentials come from,
 * in rising priority: the config's credentials.env_file (local machines),
 * SECRETS_JSON (the reusable workflow passes toJSON(secrets)), then the
 * process environment. The config itself never contains a credential, only
 * the NAME of the variable that holds it.
 *
 * The skip list is the one declaration that both the deploy excludes and the
 * drift check are derived from: ignore + server_owned + secrets.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const cfgArg = argv[argv.indexOf('--config') + 1];
if (!argv.includes('--config') || !cfgArg) {
  console.error('usage: config.js --config <site.config.json> --shell');
  process.exit(2);
}
const file = path.resolve(cfgArg);
const c = JSON.parse(fs.readFileSync(file, 'utf8'));
for (const k of ['name', 'label', 'transport', 'source']) {
  if (!c[k]) { console.error(`${file}: missing "${k}"`); process.exit(2); }
}

const expandHome = p => p.replace(/^~(?=$|\/)/, os.homedir());
const env = {};
const cred = c.credentials || {};
if (cred.env_file) {
  const p = path.isAbsolute(cred.env_file) || cred.env_file.startsWith('~')
    ? expandHome(cred.env_file) : path.join(path.dirname(file), cred.env_file);
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
if (process.env.SECRETS_JSON) {
  try { Object.assign(env, JSON.parse(process.env.SECRETS_JSON)); } catch (e) { /* ignore */ }
}
Object.assign(env, process.env);

const ALWAYS = ['.DS_Store', '.git/', 'node_modules/'];
const skip = [...ALWAYS, ...(c.ignore || []), ...(c.server_owned || []), ...(c.secrets || [])];
const globs = skip.map(s => s.endsWith('/') ? `${s}*` : s);

const out = {
  SITE_NAME: c.name,
  SITE_LABEL: c.label,
  SITE_TRANSPORT: c.transport,
  SITE_SOURCE: c.source,
  SITE_REMOTE: (cred.remote_dir && env[cred.remote_dir]) || c.remote || '.',
  SITE_DELETES: c.deletes ? '1' : '',
  SITE_EXCLUDE_GLOBS: globs.join('\n'),
  FTP_HOST: (cred.host && env[cred.host]) || env.FTP_HOST || '',
  FTP_USER: (cred.user && env[cred.user]) || env.FTP_USER || '',
  FTP_PASSWORD: (cred.password && env[cred.password]) || env.FTP_PASSWORD || '',
  FTP_PORT: (cred.port && env[cred.port]) || c.port || '21',
  FTP_PROTOCOL: (cred.protocol && env[cred.protocol]) || c.protocol || 'ftp',
  FTP_TLS: c.tls ? '1' : '',
  NTFY_URL: (c.alerts && c.alerts.ntfy_secret && env[c.alerts.ntfy_secret]) || env.NTFY_URL || '',
  // rsync over ssh: port and local key path from config.ssh; in CI the
  // workflow writes the key named by ssh.key_secret to SSH_KEY_FILE.
  SSH_PORT: (c.ssh && c.ssh.port) ? String(c.ssh.port) : '',
  SSH_KEY_PATH: (c.ssh && c.ssh.key) ? expandHome(c.ssh.key) : '',
  SSH_KEY_SECRET: (c.ssh && c.ssh.key_secret) || '',
  SSH_PRIVATE_KEY: (c.ssh && c.ssh.key_secret && env[c.ssh.key_secret]) || env.SSH_PRIVATE_KEY || '',
};

if (argv.includes('--shell')) {
  const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
  for (const [k, v] of Object.entries(out)) console.log(`${k}=${q(v)}`);
} else {
  const safe = Object.assign({}, out, { FTP_PASSWORD: out.FTP_PASSWORD ? '***' : '', SSH_PRIVATE_KEY: out.SSH_PRIVATE_KEY ? '***' : '' });
  console.log(JSON.stringify(safe, null, 2));
}
