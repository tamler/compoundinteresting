#!/usr/bin/env node
import { main } from './main.mjs';

const controller = new AbortController();
let brokenPipe = false;
const interrupt = () => controller.abort();
const outputError = error => {
  brokenPipe = error.code === 'EPIPE';
  controller.abort();
  process.exitCode = brokenPipe ? 0 : 2;
};
process.on('SIGINT', interrupt);
process.stdout.on('error', outputError);
process.stderr.on('error', outputError);
try {
  process.exitCode = await main(process.argv.slice(2), { signal: controller.signal });
  if (brokenPipe) process.exitCode = 0;
} catch { process.exitCode = brokenPipe ? 0 : 2; }
finally { process.removeListener('SIGINT', interrupt); }
