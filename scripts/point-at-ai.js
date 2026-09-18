#!/usr/bin/env node
/**
 * Point the backend at a freshly rented AI box.
 *
 *   npm run ai:point -- http://38.29.145.157:40347
 *
 * Every rental publishes a different host and port, so this is the step that is
 * otherwise done by hand and got wrong. It does three things: checks the box is
 * actually answering, rewrites AI_SERVICE_URL in .env, and touches a source file
 * so `npm run start:dev` restarts and picks the value up - the config is read
 * once at boot, so editing .env alone changes nothing until then.
 *
 * A published port is not a working service: the container answers about three
 * and a half minutes before the models finish loading, so the check reports
 * which of the two is true rather than just succeeding.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const raw = process.argv[2];
if (!raw) {
  console.error('Usage: npm run ai:point -- http://<host>:<port>');
  console.error('Get the address from ai-service: python tools/rent_gpu.py address');
  process.exit(1);
}

const url = raw.replace(/\/+$/, '');
if (!/^https?:\/\/[^/]+$/.test(url)) {
  console.error(`Not an address: ${raw}`);
  console.error('Expected something like http://38.29.145.157:40347');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
const TOUCH_FILE = path.join(ROOT, 'src', 'main.ts');

function health(target) {
  return new Promise((resolve) => {
    const client = target.startsWith('https') ? https : http;
    const request = client.get(`${target}/health`, { timeout: 10000 }, (response) => {
      let body = '';
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    request.on('error', () => resolve(null));
    request.on('timeout', () => {
      request.destroy();
      resolve(null);
    });
  });
}

function writeEnv(target) {
  const lines = fs.existsSync(ENV_FILE)
    ? fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)
    : [];
  const kept = lines.filter((line) => !line.startsWith('AI_SERVICE_URL='));
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  kept.push(`AI_SERVICE_URL=${target}`);
  fs.writeFileSync(ENV_FILE, kept.join('\n') + '\n', 'utf8');
}

(async () => {
  const state = await health(url);

  if (!state) {
    console.log(`  ${url} is not answering yet.`);
    console.log('  Models take about 3m30s to load after the container starts.');
  } else if (state.vlm?.attached && state.detector?.attached) {
    console.log(`  READY - Qwen and detector attached, ${state.knowledge?.chunks} passages`);
  } else {
    console.log('  Answering, but the models are still loading.');
  }

  writeEnv(url);
  console.log(`  AI_SERVICE_URL=${url} written to .env`);

  // nest --watch watches source, not .env, so nothing would reload otherwise.
  if (fs.existsSync(TOUCH_FILE)) {
    const now = new Date();
    fs.utimesSync(TOUCH_FILE, now, now);
    console.log('  Dev server nudged; it will restart on the new address.');
  }

  if (!state) {
    console.log('\n  Address saved anyway. Run this again once the box is up to confirm.');
  }
})();
