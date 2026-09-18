#!/usr/bin/env node
/**
 * Point the backend at a freshly rented AI box, and restart it so the change
 * takes effect.
 *
 *   npm run ai:point -- http://38.29.145.157:40153
 *
 * Every rental publishes a different host and port, so this is the step that is
 * otherwise done by hand and got wrong. It does four things: checks the box is
 * actually answering, rewrites AI_SERVICE_URL in .env, restarts whatever is
 * serving the API, and then waits until the backend itself reports the AI as
 * connected - because the previous version stopped after writing the file and
 * said "dev server nudged", which was true only under `nest --watch` and
 * silently false every other way. The address was right, the process was old,
 * and the app kept saying the assistant could not be reached.
 *
 * A published port is not a working service: the container answers about three
 * and a half minutes before the models finish loading, so the check reports
 * which of the two is true rather than just succeeding.
 *
 * On a server, do not let this stop and start the process itself - whatever
 * supervises it will fight you. Set AI_POINT_RESTART to the command that owns
 * the lifecycle and it is run instead:
 *
 *   AI_POINT_RESTART="pm2 restart fixhome-backend"
 *   AI_POINT_RESTART="systemctl restart fixhome-backend"
 *   AI_POINT_RESTART="docker compose restart backend"
 *
 * AI_POINT_RESTART=none writes the file and restarts nothing, for a deploy that
 * reloads on its own.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { execSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');

const raw = process.argv[2];
if (!raw) {
  console.error('Usage: npm run ai:point -- http://<host>:<port>');
  console.error('Get the address from ai-service: rent_gpu.py address');
  process.exit(1);
}

const url = raw.replace(/\/+$/, '');
if (!/^https?:\/\/[^/]+$/.test(url)) {
  console.error(`Not an address: ${raw}`);
  console.error('Expected something like http://38.29.145.157:40153');
  console.error('The http:// is not optional.');
  process.exit(1);
}

// ---------------------------------------------------------------- helpers

function readEnv() {
  if (!fs.existsSync(ENV_FILE)) return {};
  const values = {};
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2];
  }
  return values;
}

function get(target, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const client = target.startsWith('https') ? https : http;
    const request = client.get(target, { timeout: timeoutMs }, (response) => {
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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeEnv(target) {
  const lines = fs.existsSync(ENV_FILE)
    ? fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)
    : [];
  const kept = lines.filter((line) => !line.startsWith('AI_SERVICE_URL='));
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  kept.push(`AI_SERVICE_URL=${target}`);
  fs.writeFileSync(ENV_FILE, kept.join('\n') + '\n', 'utf8');
}

/**
 * Stop whatever is listening on the API port, whichever port that is.
 *
 * The port is read from .env rather than assumed: this project runs on 3001
 * because 3000 belongs to something else on the developer's machine, and a
 * script that hardcodes either is wrong half the time.
 */
function stopWhateverIsOnPort(port) {
  const isWindows = process.platform === 'win32';
  try {
    if (isWindows) {
      const out = execSync(
        `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -Unique -ExpandProperty OwningProcess"`,
        { encoding: 'utf8' },
      );
      const pids = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      for (const pid of pids) {
        execSync(`powershell -NoProfile -Command "Stop-Process -Id ${pid} -Force"`);
      }
      return pids.length;
    }
    const out = execSync(`lsof -ti tcp:${port} || true`, { encoding: 'utf8' });
    const pids = out.split('\n').map((s) => s.trim()).filter(Boolean);
    for (const pid of pids) process.kill(Number(pid), 'SIGTERM');
    return pids.length;
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------------- main

(async () => {
  const state = await get(`${url}/health`);
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

  const supervised = process.env.AI_POINT_RESTART;
  const port = Number(readEnv().PORT || process.env.PORT || 3000);

  if (supervised === 'none') {
    console.log('  AI_POINT_RESTART=none - restart it yourself.');
    return;
  }

  if (supervised) {
    console.log(`  Restarting: ${supervised}`);
    execSync(supervised, { stdio: 'inherit', cwd: ROOT });
  } else {
    const stopped = stopWhateverIsOnPort(port);
    console.log(`  Stopped ${stopped} process(es) on port ${port}`);

    // Detached, so the restart outlives this script. Output goes to a file
    // rather than nowhere: a backend that dies on boot has to be readable.
    const logPath = path.join(ROOT, 'backend.log');
    const log = fs.openSync(logPath, 'a');
    // npm is a shell script on Windows, so it needs the shell; passing the
    // whole command as one string keeps Node from warning about unescaped
    // arguments, and there is nothing user-supplied in it to escape.
    const child = spawn(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['run', 'start:dev'],
      { cwd: ROOT, detached: true, stdio: ['ignore', log, log] },
    );
    child.unref();
    console.log(`  Backend restarting, output in ${path.basename(logPath)}`);
  }

  // The claim to verify is not "the file was written", it is "the backend can
  // reach the AI". Anything less is what made the app say the assistant was
  // unreachable while the address on disk was correct.
  process.stdout.write('  Waiting for the backend');
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await wait(2000);
    process.stdout.write('.');
    const health = await get(`http://localhost:${port}/api/v1/ai/health`, 4000);
    const detail = health?.data ?? health;
    if (detail?.available) {
      console.log('\n  CONNECTED - the backend is talking to the AI.');
      return;
    }
    if (detail && !state) {
      console.log('\n  Backend is up; the AI box is still loading.');
      console.log(`  Run this again in a minute: npm run ai:point -- ${url}`);
      return;
    }
  }
  console.log('\n  Backend did not report a working AI within a minute.');
  console.log('  Check backend.log, and that the box says READY.');
})();
