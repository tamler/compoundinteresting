import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/main.mjs';

async function output(args, isTTY) {
  let out = ''; let err = '';
  const exit = await main(args, { stdout: { isTTY, write: s => { out += s; } }, stderr: { write: s => { err += s; } }, auth: { env: { CI_API_KEY: 'synthetic-format-key' } }, fetcher: async () => Response.json({ data: null, meta: { as_of: null } }) });
  return { exit, out, err };
}

test('automatic output is JSON for piped success/help/local errors and tables in a terminal', async () => {
  const piped = await output(['rating', 'AAPL'], false);
  assert.equal(piped.exit, 0); assert.equal(piped.err, ''); assert.equal(JSON.parse(piped.out).data, null);
  const tty = await output(['rating', 'AAPL'], true);
  assert.equal(tty.exit, 0); assert.match(tty.out, /^Field\tValue/); assert.match(tty.out, /value\tnull/);
  const help = await output(['--help'], false); assert.match(JSON.parse(help.out).help, /compoundinterest COMMAND/);
  const badPiped = await output(['unknown'], false);
  assert.equal(badPiped.exit, 2); assert.equal(badPiped.err, ''); assert.equal(JSON.parse(badPiped.out).error.code, 'invalid_input');
  const badTty = await output(['unknown'], true);
  assert.equal(badTty.exit, 2); assert.equal(badTty.out, ''); assert.match(badTty.err, /^invalid_input:/);
});

test('explicit format overrides output terminal detection including local errors', async () => {
  for (const args of [['rating', 'AAPL'], ['unknown']]) {
    const json = await output([...args, '--format', 'json'], true);
    assert.doesNotThrow(() => JSON.parse(json.out)); assert.equal(json.err, '');
    const table = await output([...args, '--format', 'table'], false);
    if (args[0] === 'unknown') { assert.equal(table.out, ''); assert.match(table.err, /^invalid_input:/); }
    else assert.match(table.out, /^Field\tValue/);
  }
});
