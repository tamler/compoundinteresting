import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { authContext, authStatus, credential, logout, readKey, saveCredential, validateKey } from '../src/auth.mjs';
import { main } from '../src/main.mjs';

const KEY = 'synthetic-auth-key-for-tests';
async function sandbox(t, overrides = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ci-auth-acceptance-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return authContext({ home, platform: 'linux', env: {}, uid: process.getuid(), ...overrides });
}
const unsafe = e => e.code === 'unsafe_config' && e.exit === 2;

test('both OS config locations are isolated; root must be absolute and platform supported', async t => {
  const ctx = await sandbox(t);
  assert.equal(ctx.file, path.join(ctx.home, '.config', 'compoundinterest', 'credentials.json'));
  const mac = authContext({ platform: 'darwin', home: ctx.home, env: {}, uid: ctx.uid });
  assert.equal(mac.file, path.join(ctx.home, 'Library', 'Application Support', 'CompoundInterest', 'credentials.json'));
  const xdg = authContext({ platform: 'linux', home: ctx.home, env: { XDG_CONFIG_HOME: path.join(ctx.home, 'custom') }, uid: ctx.uid });
  assert.equal(xdg.file, path.join(ctx.home, 'custom', 'compoundinterest', 'credentials.json'));
  assert.throws(() => authContext({ platform: 'linux', env: { XDG_CONFIG_HOME: 'relative' } }), unsafe);
  assert.throws(() => authContext({ platform: 'win32' }), e => e.code === 'unsupported_platform' && e.message === 'This client supports macOS and Linux only.');
});

test('private credential persistence, status privacy, atomic replacement and file-only logout', async t => {
  const ctx = await sandbox(t);
  await assert.rejects(credential(ctx), e => e.exit === 3 && e.code === 'auth_required');
  const result = await saveCredential(KEY, ctx);
  assert.ok(!JSON.stringify(result).includes(KEY));
  const dir = await fs.lstat(ctx.dir); const file = await fs.lstat(ctx.file);
  assert.equal(dir.mode & 0o777, 0o700); assert.equal(file.mode & 0o777, 0o600);
  assert.equal(dir.uid, ctx.uid); assert.equal(file.uid, ctx.uid); assert.equal(file.nlink, 1);
  assert.equal(await credential(ctx), KEY);
  assert.deepEqual(await authStatus(ctx), { configured: true, source: 'file', path: ctx.file });
  await saveCredential('synthetic-replacement', ctx);
  assert.equal(await credential(ctx), 'synthetic-replacement');
  assert.deepEqual(await fs.readdir(ctx.dir), ['credentials.json']);
  const envCtx = { ...ctx, env: { CI_API_KEY: 'synthetic-env-wins' } };
  assert.equal(await credential(envCtx), 'synthetic-env-wins');
  assert.deepEqual(await authStatus(envCtx), { configured: true, source: 'environment', path: null });
  assert.deepEqual(await logout(envCtx), { removed: true, environment_unchanged: true, server_key_revoked: false });
  assert.equal(envCtx.env.CI_API_KEY, 'synthetic-env-wins');
  assert.equal(await credential(envCtx), 'synthetic-env-wins');
  assert.equal((await logout(ctx)).removed, false);
  assert.deepEqual(await fs.readdir(ctx.dir), []);
});

test('environment precedence neither reads unsafe stored file nor falls back from invalid env', async t => {
  const ctx = await sandbox(t); await saveCredential(KEY, ctx); await fs.chmod(ctx.file, 0o644);
  const env = { CI_API_KEY: 'synthetic-env' };
  assert.equal(await credential({ ...ctx, env }), env.CI_API_KEY);
  for (const bad of ['', 'bad key', '\nsecret', 'a'.repeat(4097)]) {
    await assert.rejects(credential({ ...ctx, env: { CI_API_KEY: bad } }), unsafe);
  }
  assert.equal((await fs.stat(ctx.file)).mode & 0o777, 0o644);
});

test('unsafe directory/file paths reject read, write and logout without touching target', async t => {
  const cases = ['directory-mode', 'directory-symlink', 'file-mode', 'file-symlink', 'file-hardlink', 'file-directory', 'foreign-owner', 'oversized', 'invalid-json', 'extra-field', 'invalid-utf8'];
  for (const variant of cases) {
    const ctx = await sandbox(t); await saveCredential(KEY, ctx);
    const external = path.join(ctx.home, 'target'); await fs.writeFile(external, 'untouched-external', { mode: 0o600 });
    if (variant === 'directory-mode') await fs.chmod(ctx.dir, 0o755);
    if (variant === 'directory-symlink') { await fs.rename(ctx.dir, path.join(ctx.home, 'saved')); await fs.symlink(path.join(ctx.home, 'saved'), ctx.dir); }
    if (variant === 'file-mode') await fs.chmod(ctx.file, 0o640);
    if (variant === 'file-symlink') { await fs.unlink(ctx.file); await fs.symlink(external, ctx.file); }
    if (variant === 'file-hardlink') await fs.link(ctx.file, path.join(ctx.home, 'alias'));
    if (variant === 'file-directory') { await fs.unlink(ctx.file); await fs.mkdir(ctx.file, { mode: 0o600 }); }
    const probeCtx = variant === 'foreign-owner' ? { ...ctx, uid: ctx.uid + 1 } : ctx;
    if (variant === 'oversized') await fs.writeFile(ctx.file, 'x'.repeat(8193));
    if (variant === 'invalid-json') await fs.writeFile(ctx.file, '{');
    if (variant === 'extra-field') await fs.writeFile(ctx.file, JSON.stringify({ schema: 1, key: KEY, another: true }));
    if (variant === 'invalid-utf8') await fs.writeFile(ctx.file, Buffer.from([0xff]));
    await assert.rejects(credential(probeCtx), unsafe, variant);
    // Invalid content is repairable by explicit login, but unsafe filesystem identity is not.
    if (!['invalid-json', 'extra-field', 'invalid-utf8'].includes(variant)) {
      await assert.rejects(saveCredential('synthetic-new', probeCtx), unsafe, variant);
      await assert.rejects(logout(probeCtx), unsafe, variant);
    }
    assert.equal(await fs.readFile(external, 'utf8'), 'untouched-external', variant);
  }
});

test('key grammar and stdin bounds reject malformed bytes, extra lines and oversized values', async () => {
  assert.equal(validateKey('a'.repeat(4096)).length, 4096);
  for (const bad of ['', ' x', 'x ', 'x\ny', 'x\t', 'x\u007fy', 'x\u202ey', 'x'.repeat(4097)]) assert.throws(() => validateKey(bad), unsafe);
  for (const bytes of [Buffer.from(KEY), Buffer.from(KEY + '\n'), Buffer.from(KEY + '\r\n')]) {
    const input = new PassThrough(); const p = readKey(input, { write() {} }, true); input.end(bytes); assert.equal(await p, KEY);
  }
  for (const bytes of [Buffer.from('a'.repeat(4097)), Buffer.from('a'.repeat(4099)), Buffer.from(KEY + '\n\n'), Buffer.from([0xff])]) {
    const input = new PassThrough(); const p = readKey(input, { write() {} }, true); input.end(bytes);
    await assert.rejects(p);
  }
});

class Tty extends EventEmitter {
  isTTY = true; isRaw = false; modes = []; paused = false;
  setRawMode(v) { this.isRaw = v; this.modes.push(v); }
  pause() { this.paused = true; }
  resume() {}
}
test('raw terminal input edits without echo and restores terminal mode on enter, cancel and EOF', async () => {
  for (const [bytes, expected] of [[Buffer.from('syntheticX\x7f-key\r'), 'synthetic-key'], [Buffer.from('aX\by\n'), 'ay']]) {
    const input = new Tty(); let display = ''; const p = readKey(input, { write: s => { display += s; } }, false);
    input.emit('data', bytes); assert.equal(await p, expected);
    assert.equal(display, 'API key (hidden): \n'); assert.deepEqual(input.modes, [true, false]); assert.equal(input.paused, true);
    assert.equal(input.listenerCount('data'), 0);
  }
  for (const ending of ['cancel', 'end', 'error', 'oversize']) {
    const input = new Tty(); input.isRaw = true; let display = '';
    const p = readKey(input, { write: s => { display += s; } }, false);
    const rejected = assert.rejects(p, e => ending === 'cancel' ? e.exit === 130 : e.code === 'unsafe_config');
    if (ending === 'cancel') input.emit('data', Buffer.from('synthetic-hidden\x03'));
    else if (ending === 'oversize') input.emit('data', Buffer.from('a'.repeat(4097)));
    else input.emit(ending, ending === 'error' ? new Error(KEY) : undefined);
    await rejected; assert.deepEqual(input.modes, [true, true]); assert.equal(input.listenerCount('data'), 0); assert.ok(!display.includes('synthetic-hidden'));
  }
  await assert.rejects(readKey(new PassThrough(), { write() {} }, false), e => e.code === 'tty_required');
});

test('auth commands perform no network and plaintext warning precedes reading/writing', async t => {
  const ctx = await sandbox(t); let warned = false; let network = 0; let out = '';
  const input = new PassThrough();
  const originalIterator = input[Symbol.asyncIterator].bind(input);
  input[Symbol.asyncIterator] = function () { assert.equal(warned, true); return originalIterator(); };
  const io = { auth: ctx, stdin: input, stdout: { write: s => { out += s; } }, stderr: { write: s => { assert.match(s, /local plaintext/); warned = true; } }, fetcher: async () => { network++; throw new Error(KEY); } };
  const running = main(['auth', 'login', '--stdin', '--format', 'json'], io); input.end(KEY + '\n');
  assert.equal(await running, 0); assert.equal(network, 0); assert.ok(!out.includes(KEY));
  for (const cmd of ['status', 'logout']) {
    out = ''; assert.equal(await main(['auth', cmd, '--format', 'json'], io), 0); assert.ok(!out.includes(KEY));
  }
  assert.equal(network, 0);
});
