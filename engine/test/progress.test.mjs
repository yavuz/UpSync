import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { startSftpServer } from './sftp-server.mjs';
import { startEngine, waitFor } from './client.mjs';

// Manuel upload/download/sync işlemleri dosya başına transfer olayı yaymalı.
// Aksi halde arayüz büyük bir senkron sırasında ilerleme gösteremez —
// kullanıcı açısından uygulama donmuş görünür.

let server;
let engine;
let localRoot;
let remoteRoot;
const events = [];

const FILE_COUNT = 12;

before(async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upsync-progress-'));
  localRoot = path.join(tmp, 'local');
  remoteRoot = path.join(tmp, 'remote');
  await fsp.mkdir(path.join(localRoot, 'src'), { recursive: true });
  await fsp.mkdir(remoteRoot, { recursive: true });

  for (let i = 0; i < FILE_COUNT; i++) {
    await fsp.writeFile(path.join(localRoot, 'src', `f${i}.php`), `<?php // ${i}`);
  }

  server = await startSftpServer({ root: remoteRoot });

  await fsp.mkdir(path.join(localRoot, '.zed'), { recursive: true });
  await fsp.writeFile(
    path.join(localRoot, '.zed', 'sftp.json'),
    JSON.stringify({
      host: '127.0.0.1',
      port: server.port,
      protocol: 'sftp',
      username: server.username,
      password: server.password,
      remotePath: '/',
      // İzleyici kapalı: gelen olaylar yalnızca manuel işlemden gelsin.
      uploadOnSave: false,
      ignore: ['.zed/**'],
    })
  );

  engine = startEngine({ onEvent: e => events.push(e) });
  const status = await engine.call('addFolder', { id: 'p', path: localRoot });
  assert.equal(status.error, null, `config hatası: ${status.error}`);
  assert.equal(status.watching, false, 'izleyici kapalı olmalıydı');
});

after(async () => {
  await engine?.stop();
  await server?.close();
});

const transfers = (phase, kind) =>
  events.filter(
    e => e.type === 'transfer' && e.phase === phase && (!kind || e.kind === kind)
  );

test('manuel klasor yuklemesi dosya basina start olayi yayar', async () => {
  events.length = 0;
  await engine.call('upload', { id: 'p', path: path.join(localRoot, 'src') });

  const started = transfers('start', 'upload');
  assert.equal(
    started.length,
    FILE_COUNT,
    `dosya başına start bekleniyordu, gelen: ${started.length}`
  );
});

test('manuel klasor yuklemesi dosya basina done olayi yayar', () => {
  const done = transfers('done', 'upload');
  assert.equal(done.length, FILE_COUNT);
  // Süre ölçümü de gelmeli; arayüz bunu gösteriyor.
  assert.ok(done.every(e => typeof e.ms === 'number'));
  // Her olay gerçek bir dosya yolu taşımalı.
  assert.ok(done.every(e => e.localPath.endsWith('.php')));
});

test('indirme olaylari download olarak isaretlenir', async () => {
  events.length = 0;
  await fsp.rm(path.join(localRoot, 'src'), { recursive: true, force: true });
  await engine.call('download', { id: 'p', path: path.join(localRoot, 'src') });

  const done = transfers('done', 'download');
  assert.equal(done.length, FILE_COUNT, 'indirme olayları eksik');
  assert.equal(transfers('done', 'upload').length, 0, 'yön yanlış etiketlenmiş');
});

test('sync de dosya basina olay yayar', async () => {
  events.length = 0;
  await fsp.writeFile(path.join(localRoot, 'src', 'yeni.php'), '<?php // yeni');
  await engine.call('sync', {
    id: 'p',
    path: path.join(localRoot, 'src'),
    direction: 'localToRemote',
  });

  assert.ok(transfers('done', 'upload').length >= 1, 'sync sessiz kaldı');
});

test('olaylar tek sefer yayilir (cift raporlama yok)', async () => {
  events.length = 0;
  const one = path.join(localRoot, 'tek.php');
  await fsp.writeFile(one, '<?php // tek');
  await engine.call('upload', { id: 'p', path: one });

  assert.equal(transfers('start').length, 1);
  assert.equal(transfers('done').length, 1);
});
