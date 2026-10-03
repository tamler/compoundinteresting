import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../src/bin.mjs', import.meta.url));
async function isolated(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ci-bin-acceptance-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  // Never inherit a real user's customer or operator credential.
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg'), TMPDIR: os.tmpdir() };
  return { home, env };
}
async function run(args, env, stdin = '') {
  const child = spawn(process.execPath, [bin, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', s => { out += s; }); child.stderr.on('data', s => { err += s; });
  child.stdin.on('error', () => {}); child.stdin.end(stdin);
  // Only this exact child may be terminated, using SIGTERM, if it stalls.
  let stalled = false;
  const timer = setTimeout(() => { stalled = true; child.kill('SIGTERM'); }, 5000);
  const [code, signal] = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (...v) => resolve(v)); });
  clearTimeout(timer); assert.equal(stalled, false, 'owned CLI process stalled'); assert.equal(signal, null);
  return { code, out, err };
}

test('real executable help, bad arguments and missing/invalid auth have safe exit codes', async t => {
  const { env } = await isolated(t);
  let r = await run(['--help'], env); assert.equal(r.code, 0); assert.match(r.out, /read-only Data API client/); assert.doesNotMatch(r.out, /preview/); assert.equal(r.err, '');
  r = await run(['--help', '--format', 'json'], env); assert.equal(r.code, 0); assert.match(JSON.parse(r.out).help, /compoundinterest COMMAND/);
  r = await run(['ownership', 'AAPL', '--format', 'json'], env); assert.equal(r.code, 2); assert.equal(JSON.parse(r.out).error.code, 'invalid_input'); assert.equal(r.err, '');
  r = await run(['ticker', 'AAPL', '--format', 'json'], env); assert.equal(r.code, 3); assert.equal(JSON.parse(r.out).error.code, 'auth_required');
  r = await run(['ticker', 'AAPL', '--format', 'json'], { ...env, CI_API_KEY: 'synthetic unsafe credential' });
  assert.equal(r.code, 2); assert.equal(JSON.parse(r.out).error.code, 'unsafe_config'); assert.ok(!(r.out + r.err).includes('synthetic unsafe credential'));
  r = await run(['auth', 'login', '--format', 'json'], env); assert.equal(r.code, 2); assert.equal(JSON.parse(r.out).error.code, 'tty_required'); assert.match(r.err, /local plaintext/);
});

test('real executable login/status/logout isolates HOME, permissions and credential output', async t => {
  const { env, home } = await isolated(t); const key = 'synthetic-executable-key-never-print';
  let r = await run(['auth', 'login', '--stdin', '--format', 'json'], env, key + '\n');
  assert.equal(r.code, 0); assert.match(r.err, /local plaintext/); assert.ok(!(r.out + r.err).includes(key));
  const p = JSON.parse(r.out).data.path;
  assert.ok(p.startsWith(home + path.sep));
  assert.equal((await fs.stat(p)).mode & 0o777, 0o600); assert.equal((await fs.stat(path.dirname(p))).mode & 0o777, 0o700);
  r = await run(['auth', 'status', '--format', 'table'], env); assert.equal(r.code, 0); assert.match(r.out, /source\tfile/); assert.ok(!(r.out + r.err).includes(key));
  r = await run(['auth', 'status', '--format', 'json'], { ...env, CI_API_KEY: 'synthetic-env-priority' });
  assert.deepEqual(JSON.parse(r.out).data, { configured: true, source: 'environment', path: null });
  r = await run(['auth', 'logout', '--format', 'json'], { ...env, CI_API_KEY: 'synthetic-env-priority' });
  assert.equal(r.code, 0); assert.equal(JSON.parse(r.out).data.environment_unchanged, true); assert.equal(JSON.parse(r.out).data.server_key_revoked, false);
  await assert.rejects(fs.stat(p), e => e.code === 'ENOENT');
  r = await run(['auth', 'login', '--stdin', '--format', 'json'], env, 'a'.repeat(4099));
  assert.equal(r.code, 2); assert.ok(!(r.out + r.err).includes('a'.repeat(100)));
});

test('real executable broken stdout pipe exits0 without a stack', async t => {
  const { env } = await isolated(t);
  const child = spawn(process.execPath, [bin, '--help'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; child.stderr.on('data', s => { err += s; }); child.stdout.destroy();
  let stalled = false; const timer = setTimeout(() => { stalled = true; child.kill('SIGTERM'); }, 5000);
  const [code, signal] = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (...v) => resolve(v)); });
  clearTimeout(timer); assert.equal(stalled, false); assert.equal(signal, null); assert.equal(code, 0); assert.equal(err, '');
});
