#!/usr/bin/env node
/*
 * live-check.js: does what is live match what is committed?
 *
 * Deploys mirror one way and never look at what is already on the server, so a
 * stale checkout can silently overwrite work done from another machine or
 * edited directly on the host. This compares each live site against git and
 * reports drift, with direction:
 *
 *   live matches HEAD              in sync
 *   live matches an older commit   just undeployed work, quiet
 *   live matches nothing in git    edited elsewhere, FAILS
 *   live-only files                fail only where the deploy uses --delete
 *
 * Sites are declared in site.config.json files in the calling repo. The same
 * file drives deploy excludes, so the deploy and this check can never disagree
 * about which paths are server-owned.
 *
 *   node live-check.js                     every site.config.json in the repo
 *   node live-check.js --config <path>     one config (repeatable)
 *   node live-check.js --site <name>       filter by config "name"
 *   node live-check.js --deep              exact content hashes, not just sizes
 *   node live-check.js --cached            instant; for session-start hooks
 *   node live-check.js --json
 *
 * Exit: 0 clean, 1 drift found, 2 could not check.
 *
 * Credentials: env vars first (CI), then SECRETS_JSON (the reusable workflow
 * passes toJSON(secrets)), then the config's credentials.env_file (local).
 */
'use strict';
const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const flag = f => argv.includes(f);
const flagVals = f => argv.map((a, i) => a === f ? argv[i + 1] : null).filter(Boolean);
const DEEP = flag('--deep'), CACHED = flag('--cached'), JSON_OUT = flag('--json');
const ONLY = flagVals('--site');
const CONFIGS = flagVals('--config');

const REPO = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
const CACHE = path.join(REPO, '.live-check-status.json');
const CACHE_MAX_AGE_H = 6;
const LFTP = process.env.LFTP_BIN ||
  ['/opt/homebrew/bin/lftp', '/usr/local/bin/lftp', '/usr/bin/lftp'].find(p => fs.existsSync(p)) ||
  'lftp';
// macOS ships openrsync (protocol 29), which misreports checksums on some
// files. Prefer a real rsync when one is installed (brew install rsync).
const RSYNC = process.env.RSYNC_BIN ||
  ['/opt/homebrew/bin/rsync', '/usr/local/bin/rsync'].find(p => fs.existsSync(p)) || 'rsync';
const ALWAYS_SKIP = ['.DS_Store', '.git/', 'node_modules/'];

const log = (...a) => { if (!JSON_OUT) console.log(...a); };
const expandHome = p => p.replace(/^~(?=$|\/)/, os.homedir());

// ---- config ---------------------------------------------------------------

function findConfigs() {
  if (CONFIGS.length) return CONFIGS.map(c => path.resolve(REPO, c));
  const found = [];
  const walk = (dir, depth) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      const p = path.join(dir, ent.name);
      if (ent.isFile() && ent.name === 'site.config.json') found.push(p);
      else if (ent.isDirectory() && depth < 3) walk(p, depth + 1);
    }
  };
  walk(REPO, 0);
  return found.sort();
}

function loadSite(file) {
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const k of ['name', 'label', 'transport', 'source']) {
    if (!c[k]) throw new Error(`${path.relative(REPO, file)}: missing "${k}"`);
  }
  const skip = [...ALWAYS_SKIP, ...(c.ignore || []), ...(c.server_owned || []), ...(c.secrets || [])];
  return Object.assign({ remote: '.', deletes: false, credentials: {} }, c, { file, skip });
}

// Merge every credential source. Later wins: env file < SECRETS_JSON < process.env.
function credentials(site) {
  const out = {};
  const ef = site.credentials.env_file;
  if (ef) {
    const p = path.isAbsolute(ef) || ef.startsWith('~') ? expandHome(ef) : path.join(REPO, ef);
    if (fs.existsSync(p)) {
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
        if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  }
  if (process.env.SECRETS_JSON) {
    try { Object.assign(out, JSON.parse(process.env.SECRETS_JSON)); } catch (e) { /* ignore */ }
  }
  return Object.assign(out, process.env);
}

const skipped = (rel, skip) => skip.some(s => s.endsWith('/') ? rel.startsWith(s) : rel === s);

// ---- git ------------------------------------------------------------------

// path -> {size, sha} for the committed state of a subtree
function gitTree(localDir) {
  const out = execSync(`git ls-tree -r -l HEAD -- "${localDir}"`, { cwd: REPO, encoding: 'utf8' });
  const map = new Map();
  for (const line of out.split('\n')) {
    const m = line.match(/^\d+ blob ([0-9a-f]+)\s+(\d+)\t(.+)$/);
    if (m) map.set(path.relative(localDir, m[3]), { sha: m[1], size: +m[2] });
  }
  return map;
}

// Every blob each path has ever had, so we can tell which side is ahead.
function gitHistory(localDir) {
  const raw = execSync(`git log --all --no-abbrev --format=%x00 --raw -- "${localDir}"`,
    { cwd: REPO, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  const byPath = new Map();
  const shas = new Set();
  for (const line of raw.split('\n')) {
    const m = line.match(/^:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) [A-Z]\d*\t(.+)$/);
    if (!m || /^0+$/.test(m[1])) continue;
    const rel = path.relative(localDir, m[2].split('\t').pop());
    if (!byPath.has(rel)) byPath.set(rel, { shas: new Set(), sizes: new Set() });
    byPath.get(rel).shas.add(m[1]);
    shas.add(m[1]);
  }
  if (shas.size) {
    const check = execSync('git cat-file --batch-check', {
      cwd: REPO, encoding: 'utf8', input: [...shas].join('\n'), maxBuffer: 64 * 1024 * 1024 });
    const size = new Map();
    for (const line of check.split('\n')) {
      const m = line.match(/^([0-9a-f]+) blob (\d+)$/);
      if (m) size.set(m[1], +m[2]);
    }
    for (const v of byPath.values())
      for (const s of v.shas) if (size.has(s)) v.sizes.add(size.get(s));
  }
  return byPath;
}

// ---- transports -----------------------------------------------------------

function lftpRun(site, env, cmd) {
  const c = site.credentials;
  const creds = `${env[c.user]},${env[c.password]}`;
  return execFileSync(LFTP, ['-u', creds, `ftp://${env[c.host]}`,
    '-e', `set ftp:ssl-allow no; set net:timeout 45; ${cmd}; bye`],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function checkFtp(site) {
  const c = site.credentials;
  const env = credentials(site);
  if (!c.host || !env[c.host]) {
    return { error: `no credentials: need ${c.host || 'credentials.host'} via env, SECRETS_JSON or ${c.env_file || 'credentials.env_file'}` };
  }
  const remote = (c.remote_dir && env[c.remote_dir]) || site.remote;
  const listing = lftpRun(site, env, `find -l ${remote}`);

  const live = new Map();
  for (const line of listing.split('\n')) {
    if (!line.startsWith('-')) continue;
    const m = line.match(/^\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(.+)$/);
    if (!m) continue;
    let rel = m[2].replace(/^\.\//, '');
    if (remote !== '.' && rel.startsWith(remote + '/')) rel = rel.slice(remote.length + 1);
    live.set(rel, { size: +m[1] });
  }

  const head = gitTree(site.source);
  const hist = gitHistory(site.source);
  const drift = [], behind = [], remoteOnly = [], notDeployed = [];
  for (const [rel, info] of live) {
    if (skipped(rel, site.skip)) continue;
    const h = head.get(rel);
    if (!h) {
      if (!fs.existsSync(path.join(REPO, site.source, rel))) remoteOnly.push(rel);
      continue;
    }
    if (h.size === info.size) continue;
    const seen = hist.get(rel);
    if (seen && seen.sizes.has(info.size)) behind.push(rel);
    else drift.push({ rel, live: info.size, head: h.size });
  }
  for (const rel of head.keys()) {
    if (!skipped(rel, site.skip) && !live.has(rel)) notDeployed.push(rel);
  }
  if (!DEEP) return { drift, behind, remoteOnly, notDeployed, mode: 'fast' };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'livecheck-'));
  try {
    lftpRun(site, env, `mirror --include-glob '*.html' --include-glob '*.js' ` +
      `--include-glob '*.php' --include-glob '*.css' --include-glob '*.json' ` +
      `--include-glob '*.txt' --include-glob '*.sql' ${remote} ${tmp}`);
    for (const [rel, h] of head) {
      if (skipped(rel, site.skip)) continue;
      const f = path.join(tmp, rel);
      if (!fs.existsSync(f)) continue;
      if (drift.find(d => d.rel === rel)) continue;
      const sha = execSync(`git hash-object "${f}"`, { cwd: REPO, encoding: 'utf8' }).trim();
      if (sha === h.sha) continue;
      const seen = hist.get(rel);
      if (seen && seen.shas.has(sha)) behind.push(rel);
      else drift.push({ rel, live: 'differs', head: 'HEAD' });
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  return { drift, behind, remoteOnly, notDeployed, mode: 'deep' };
}

// ssh options for an rsync site: config.ssh = { port, key, key_secret }.
// Locally the key is a path; in CI the reusable workflow writes the secret
// named by key_secret to SSH_KEY_FILE. Absent config.ssh, plain ssh is used
// (the Mac mini sites rely on ~/.ssh/config and Tailscale).
function sshCommand(site) {
  const o = site.ssh || {};
  const key = process.env.SSH_KEY_FILE || (o.key && expandHome(o.key));
  const parts = ['ssh', '-o BatchMode=yes', '-o StrictHostKeyChecking=accept-new'];
  if (o.port) parts.push(`-p ${o.port}`);
  if (key) parts.push(`-i '${key}'`);
  return parts.join(' ');
}

function checkRsync(site) {
  const local = path.join(REPO, site.source) + '/';
  if (!fs.existsSync(local)) return { error: `${site.source} missing` };
  const ex = site.skip.map(s => `--exclude '${s.replace(/\/$/, '')}'`).join(' ');
  let out;
  try {
    out = execSync(`"${RSYNC}" -n -a -i --delete -c -e "${sshCommand(site)}" ${ex} "${local}" "${site.remote}" 2>&1`,
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120000 });
  } catch (e) {
    const msg = ((e.stdout || '') + (e.stderr || '')).trim();
    if (/Host key verification|Permission denied|Could not resolve|Connection refused|timed out/i.test(msg))
      return { error: `cannot reach ${site.remote.split(':')[0]} over SSH (${msg.split('\n')[0]}). ssh to it once to accept the host key.` };
    return { error: `rsync failed: ${msg.split('\n').pop() || e.message}` };
  }
  const drift = [], remoteOnly = [], notDeployed = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('*deleting')) remoteOnly.push(line.replace(/^\*deleting\s+/, '').trim());
    else if (/^[<>]f/.test(line)) {
      // itemize flags: YXcstpoguax. Only a checksum (c) or size (s) difference
      // is content drift; a permission or ownership difference is not.
      const flags = line.split(/\s+/)[0];
      const rel = line.replace(/^\S+\s+/, '').trim();
      if (/\+{7}/.test(flags)) notDeployed.push(rel);
      else if (flags[2] === 'c' || flags[3] === 's') drift.push({ rel, live: 'differs', head: 'HEAD' });
    }
  }
  return { drift, behind: [], remoteOnly, notDeployed, mode: 'rsync', undirected: true };
}

// ---- --cached: for session-start hooks ------------------------------------

if (CACHED) {
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch (e) {}
  const ageH = prev ? (Date.now() - prev.at) / 3.6e6 : Infinity;

  if (!prev) console.log('Live-site drift: never checked. Running first check in the background.');
  else if (prev.status === 1) {
    console.log(`Live-site drift DETECTED (checked ${ageH.toFixed(1)}h ago):`);
    for (const [name, r] of Object.entries(prev.results)) {
      if (r.drift && r.drift.length)
        console.log(`  ${name}: ${r.drift.length} file(s) live but not in this repo` +
                    `, e.g. ${r.drift.slice(0, 3).map(d => d.rel || d).join(', ')}`);
    }
    console.log('  Reconcile before editing or deploying. Run: node scripts/live-check.js --deep');
  } else if (prev.status === 2) console.log(`Live-site drift: last check errored (${ageH.toFixed(1)}h ago).`);
  else console.log(`Live-site drift: none as of ${ageH.toFixed(1)}h ago.`);

  if (ageH > CACHE_MAX_AGE_H) {
    const { spawn } = require('child_process');
    spawn(process.execPath, [__filename], { cwd: REPO, detached: true, stdio: 'ignore' }).unref();
  }
  process.exit(0);
}

// ---- run ------------------------------------------------------------------

let sites;
try { sites = findConfigs().map(loadSite); }
catch (e) { console.error(`config error: ${e.message}`); process.exit(2); }
if (!sites.length) { console.error('no site.config.json found'); process.exit(2); }

const results = {};
let worst = 0;
for (const site of sites) {
  if (ONLY.length && !ONLY.includes(site.name)) continue;
  let r;
  try { r = site.transport === 'ftp' ? checkFtp(site) : checkRsync(site); }
  catch (e) { r = { error: e.message.split('\n')[0] }; }
  results[site.name] = r;

  if (r.error) { worst = Math.max(worst, 2); log(`\n  ${site.label}\n    ERROR  ${r.error}`); continue; }
  if (r.drift.length || (site.deletes && r.remoteOnly.length)) worst = Math.max(worst, 1);

  log(`\n  ${site.label}  (${r.mode})`);
  if (!r.drift.length && !r.remoteOnly.length && !r.notDeployed.length && !(r.behind || []).length) {
    log('    in sync');
    continue;
  }
  if (r.drift.length) {
    log(`    DRIFT: live differs from HEAD, a deploy would overwrite these (${r.drift.length}):`);
    for (const d of r.drift.slice(0, 25)) log(`      ! ${d.rel}`);
    if (r.drift.length > 25) log(`      ... +${r.drift.length - 25} more`);
  }
  if (r.remoteOnly.length) {
    log(site.deletes
      ? `    LIVE-ONLY and this deploy uses --delete, these would be DESTROYED (${r.remoteOnly.length}):`
      : `    live-only, not in git (${r.remoteOnly.length}):`);
    for (const f of r.remoteOnly.slice(0, 10)) log(`      + ${f}`);
    if (r.remoteOnly.length > 10) log(`      ... +${r.remoteOnly.length - 10} more`);
  }
  if ((r.behind || []).length)
    log(`    live is an older commit (${r.behind.length}): just undeployed work, safe to overwrite`);
  if (r.notDeployed.length)
    log(`    committed but not live (${r.notDeployed.length}): normal if you have not deployed yet`);
  if (r.undirected && r.drift.length)
    log('    note: rsync cannot tell which side is newer. Check before deploying.');
}

if (!ONLY.length && !CONFIGS.length) {
  try { fs.writeFileSync(CACHE, JSON.stringify({ at: Date.now(), deep: DEEP, status: worst, results })); }
  catch (e) { /* cache is a convenience, never fatal */ }
}

if (JSON_OUT) console.log(JSON.stringify({ status: worst, results }, null, 2));
else log(worst === 0 ? '\n  All sites in sync.\n'
       : worst === 1 ? '\n  DRIFT FOUND. Reconcile before deploying.\n'
       : '\n  Some sites could not be checked.\n');
process.exit(worst);
