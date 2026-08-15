import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { waitFor } from './client.mjs';

const ENGINE = path.resolve(fileURLToPath(new URL('../dist/engine.js', import.meta.url)));

// Uygulama çökerse motor da kapanmalı. Aksi halde arkada görünmez bir
// ikinci yükleyici kalır ve aynı dosyayı iki kez gönderir.
//
// Ara süreç bilerek Swift tarafının yaptığını taklit ediyor: motoru
// borulanmış stdio ile doğrudan çocuk olarak başlatıp canlı tutuyor.
// Daha önce bu testi bir kabuk üzerinden kurmuştuk; kabuk farklı bir
// tanıtıcı miras zinciri yarattığı için gerçek uygulamada var olan
// hatayı gizliyordu.
const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function spawnParentWithEngine() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'orphan-'));
  const parentScript = path.join(tmp, 'parent.mjs');
  await fsp.writeFile(parentScript, `
    import { spawn } from 'child_process';
    const child = spawn(process.execPath, [${JSON.stringify(ENGINE)}], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    process.stdout.write(String(child.pid) + '\\n');
    setInterval(() => {}, 1000);
  `);

  const parent = spawn(process.execPath, [parentScript], { stdio: ['ignore', 'pipe', 'ignore'] });
  let enginePid;
  parent.stdout.setEncoding('utf8');
  parent.stdout.on('data', c => {
    const first = c.trim().split('\n')[0];
    if (!enginePid && /^\d+$/.test(first)) enginePid = Number(first);
  });

  await waitFor(() => enginePid, { label: 'motor pid', timeout: 10000 });
  await waitFor(() => alive(enginePid), { label: 'motor ayakta', timeout: 10000 });
  return { parent, enginePid, tmp };
}

test('ebeveyn SIGKILL ile olunce motor da kapanir', async () => {
  const { parent, enginePid, tmp } = await spawnParentWithEngine();

  parent.kill('SIGKILL');

  await waitFor(() => !alive(enginePid), {
    label: 'motor kendini kapatmali',
    timeout: 15000,
    interval: 250,
  });

  await fsp.rm(tmp, { recursive: true, force: true });
});

test('ebeveyn SIGTERM ile olunce motor da kapanir', async () => {
  const { parent, enginePid, tmp } = await spawnParentWithEngine();

  parent.kill('SIGTERM');

  await waitFor(() => !alive(enginePid), {
    label: 'motor kendini kapatmali',
    timeout: 15000,
    interval: 250,
  });

  await fsp.rm(tmp, { recursive: true, force: true });
});
