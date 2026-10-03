import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CliError, configError, cancelled } from './errors.mjs';

const MAX_KEY = 4096;
const MAX_FILE = 8192;
export function validateKey(key) {
  if (typeof key !== 'string' || !key || Buffer.byteLength(key) > MAX_KEY || /[\s\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(key)) throw configError();
  return key;
}

export function authContext(overrides = {}) {
  const ctx = { platform: process.platform, home: os.homedir(), env: process.env, uid: process.getuid?.(), ...overrides };
  let root;
  if (ctx.platform === 'darwin') root = path.join(ctx.home, 'Library', 'Application Support');
  else if (ctx.platform === 'linux') root = ctx.env.XDG_CONFIG_HOME || path.join(ctx.home, '.config');
  else throw new CliError('unsupported_platform', 'This preview supports macOS and Linux only.');
  if (ctx.uid === undefined || !path.isAbsolute(root) || /[\x00-\x1f\x7f-\x9f]/.test(root)) throw configError();
  const dir = path.join(root, ctx.platform === 'darwin' ? 'CompoundInterest' : 'compoundinterest');
  return { ...ctx, root, dir, file: path.join(dir, 'credentials.json') };
}

async function statOrMissing(p) {
  try { return await fs.lstat(p); } catch (e) { if (e.code === 'ENOENT') return null; throw configError(); }
}

function same(a, b) { return a !== null && b !== null && a.dev === b.dev && a.ino === b.ino; }
function checkDirectory(s, ctx) {
  if (!s?.isDirectory() || s.isSymbolicLink() || s.uid !== ctx.uid || (s.mode & 0o777) !== 0o700) throw configError();
}
function checkFile(s, ctx) {
  if (!s?.isFile() || s.isSymbolicLink() || s.uid !== ctx.uid || (s.mode & 0o777) !== 0o600 || s.nlink !== 1 || s.size > MAX_FILE) throw configError();
}
async function directory(ctx, create = false) {
  let s = await statOrMissing(ctx.dir);
  if (!s && create) {
    await fs.mkdir(ctx.root, { recursive: true, mode: 0o700 });
    try { await fs.mkdir(ctx.dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw configError(); }
    s = await statOrMissing(ctx.dir);
  }
  if (s) checkDirectory(s, ctx);
  return s;
}

async function readFileKey(ctx) {
  const parent = await directory(ctx);
  if (!parent) return null;
  const before = await statOrMissing(ctx.file);
  if (!before) return null;
  checkFile(before, ctx);
  let fd;
  try {
    fd = await fs.open(ctx.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await fd.stat();
    checkFile(opened, ctx);
    if (!same(before, opened) || !same(parent, await directory(ctx))) throw configError();
    const bytes = Buffer.alloc(MAX_FILE + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await fd.read(bytes, used, bytes.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > MAX_FILE || !same(before, await statOrMissing(ctx.file))) throw configError();
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used)));
    if (!value || Object.keys(value).sort().join() !== 'key,schema' || value.schema !== 1) throw configError();
    return validateKey(value.key);
  } catch { throw configError(); } finally { await fd?.close(); }
}

export async function credential(ctx = authContext()) {
  if (Object.hasOwn(ctx.env, 'CI_API_KEY')) return validateKey(ctx.env.CI_API_KEY);
  const key = await readFileKey(ctx);
  if (!key) throw new CliError('auth_required', 'Set CI_API_KEY or run auth login. Get a key at https://compoundinterest.ing/account.', 3);
  return key;
}

export async function authStatus(ctx = authContext()) {
  if (Object.hasOwn(ctx.env, 'CI_API_KEY')) {
    validateKey(ctx.env.CI_API_KEY);
    return { configured: true, source: 'environment', path: null };
  }
  const key = await readFileKey(ctx);
  return { configured: key !== null, source: key ? 'file' : null, path: ctx.file };
}

export async function saveCredential(key, ctx = authContext()) {
  validateKey(key);
  const parent = await directory(ctx, true);
  const before = await statOrMissing(ctx.file);
  if (before) checkFile(before, ctx);
  const temp = path.join(ctx.dir, `.credentials-${randomUUID()}`);
  let fd;
  let created = false;
  try {
    fd = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    await fd.writeFile(`${JSON.stringify({ schema: 1, key })}\n`);
    await fd.sync();
    const written = await fd.stat();
    checkFile(written, ctx);
    await fd.close(); fd = undefined;
    if (!same(parent, await directory(ctx)) || !same(written, await statOrMissing(temp))) throw configError();
    const current = await statOrMissing(ctx.file);
    if (current) checkFile(current, ctx);
    if (before ? !same(before, current) : current !== null) throw configError();
    await fs.rename(temp, ctx.file);
    created = false;
  } catch { throw configError(); } finally {
    await fd?.close();
    if (created) await fs.unlink(temp).catch(() => {});
  }
  return { configured: true, source: 'file', path: ctx.file };
}

export async function logout(ctx = authContext()) {
  const parent = await directory(ctx);
  const before = parent ? await statOrMissing(ctx.file) : null;
  if (before) {
    checkFile(before, ctx);
    if (!same(parent, await directory(ctx)) || !same(before, await statOrMissing(ctx.file))) throw configError();
    await fs.unlink(ctx.file);
  }
  return { removed: before !== null, environment_unchanged: true, server_key_revoked: false };
}

export async function readKey(input, output, fromStdin) {
  if (fromStdin) {
    const chunks = [];
    let size = 0;
    for await (const chunk of input) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += b.length;
      if (size > MAX_KEY + 2) throw configError();
      chunks.push(b);
    }
    let key = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    key = key.replace(/\r?\n$/, '');
    return validateKey(key);
  }
  if (!input.isTTY || typeof input.setRawMode !== 'function') throw new CliError('tty_required', 'Use a terminal or explicitly pass auth login --stdin.');
  output.write('API key (hidden): ');
  const wasRaw = Boolean(input.isRaw);
  return new Promise((resolve, reject) => {
    const bytes = [];
    function finish(error) {
      input.removeListener('data', onData);
      input.removeListener('error', onError);
      input.removeListener('end', onEnd);
      input.setRawMode(wasRaw); input.pause(); output.write('\n');
      if (error) reject(error);
      else { try { resolve(validateKey(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes)))); } catch { reject(configError()); } }
    }
    function onError() { finish(configError()); }
    function onEnd() { finish(configError()); }
    function onData(data) {
      for (const b of Buffer.from(data)) {
        if (b === 3) { finish(cancelled()); return; }
        if (b === 13 || b === 10) { finish(); return; }
        if (b === 8 || b === 127) { bytes.pop(); continue; }
        if (b < 32 || bytes.length >= MAX_KEY) { finish(configError()); return; }
        bytes.push(b);
      }
    }
    input.setRawMode(true);
    input.on('data', onData); input.once('error', onError); input.once('end', onEnd); input.resume();
  });
}
