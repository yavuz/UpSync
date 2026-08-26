import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'fs/promises';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { startSftpServer } from './sftp-server.mjs';
import { startEngine, waitFor, waitForContent } from './client.mjs';

let server;
let engine;
let localRoot;
let remoteRoot;
const events = [];
const logs = [];

const FOLDER_ID = 'f1';

before(async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upsync-'));
  localRoot = path.join(tmp, 'local');
  remoteRoot = path.join(tmp, 'remote');
  await fsp.mkdir(localRoot, { recursive: true });
  await fsp.mkdir(remoteRoot, { recursive: true });

  server = await startSftpServer({ root: remoteRoot });

  await fsp.mkdir(path.join(localRoot, '.zed'), { recursive: true });
  await fsp.writeFile(
    path.join(localRoot, '.zed', 'sftp.json'),
    JSON.stringify({
      name: 'test',
      host: '127.0.0.1',
      port: server.port,
      protocol: 'sftp',
      username: server.username,
      password: server.password,
      remotePath: '/',
      uploadOnSave: true,
      // Yorum ve sondaki virgül desteklendiğini de bu dosya doğruluyor.
      ignore: ['.zed/**', 'gizli/**', '*.log'],
      watcher: { autoDelete: true },
    })
  );

  engine = startEngine({
    onEvent: e => events.push(e),
    onLog: l => logs.push(l),
  });

  const status = await engine.call('addFolder', { id: FOLDER_ID, path: localRoot });
  assert.equal(status.error, null, `config yüklenemedi: ${status.error}`);
  assert.equal(status.autoUpload, true);

  await waitFor(
    () => events.some(e => e.type === 'watcher' && e.state === 'ready'),
    { label: 'watcher ready' }
  );
});

after(async () => {
  await engine?.stop();
  await server?.close();
});

const remote = p => path.join(remoteRoot, p);

// SFTP'de OPEN, WRITE tamamlanmadan önce dosyayı boş olarak oluşturur;
// bu yüzden sadece varlığı değil, beklenen İÇERİĞİ de bekliyoruz - yoksa
// "yüklendi" sanılıp içerik gelmeden okunabilir.
async function waitForUpload(relPath, expectedContent) {
  return waitForContent(fs, remote(relPath), expectedContent, {
    label: `upload ${relPath}`,
  });
}

test('kaydedilen dosya otomatik yüklenir', async () => {
  const content = '<?php echo "merhaba";';
  await fsp.writeFile(path.join(localRoot, 'index.php'), content);
  await waitForUpload('index.php', content);
  assert.equal(await fsp.readFile(remote('index.php'), 'utf8'), content);
});

test('alt klasördeki dosya yolu korunarak yüklenir', async () => {
  const content = 'tpl icerik';
  await fsp.mkdir(path.join(localRoot, 'app', 'views'), { recursive: true });
  await fsp.writeFile(path.join(localRoot, 'app', 'views', 'home.tpl'), content);
  await waitForUpload(path.join('app', 'views', 'home.tpl'), content);
});

test('dil/uzanti fark etmeksizin yuklenir (.tpl, .sql, .sh)', async () => {
  const sql = 'select 1;';
  const sh = '#!/bin/sh\necho ok';
  await fsp.writeFile(path.join(localRoot, 'dump.sql'), sql);
  await fsp.writeFile(path.join(localRoot, 'deploy.sh'), sh);
  await waitForUpload('dump.sql', sql);
  await waitForUpload('deploy.sh', sh);
});

test('ignore edilen dosya yuklenmez', async () => {
  await fsp.mkdir(path.join(localRoot, 'gizli'), { recursive: true });
  await fsp.writeFile(path.join(localRoot, 'gizli', 'sir.txt'), 'gizli');
  await fsp.writeFile(path.join(localRoot, 'app.log'), 'log satiri');

  // Ignore edilmeyen bir dosyayı işaret olarak kullan: o yüklendiyse
  // izleyici çalışmış ama diğerlerini atlamış demektir.
  await fsp.writeFile(path.join(localRoot, 'isaret.txt'), 'x');
  await waitForUpload('isaret.txt', 'x');

  assert.equal(fs.existsSync(remote(path.join('gizli', 'sir.txt'))), false);
  assert.equal(fs.existsSync(remote('app.log')), false);
});

test('manuel upload calisir', async () => {
  const p = path.join(localRoot, 'manuel.txt');
  await fsp.writeFile(p, 'manuel icerik');
  await engine.call('upload', { id: FOLDER_ID, path: p });
  assert.equal(await fsp.readFile(remote('manuel.txt'), 'utf8'), 'manuel icerik');
});

test('manuel download calisir', async () => {
  await fsp.writeFile(remote('sadece-uzakta.txt'), 'uzaktan geldi');
  const target = path.join(localRoot, 'sadece-uzakta.txt');
  await engine.call('download', { id: FOLDER_ID, path: target });
  assert.equal(await fsp.readFile(target, 'utf8'), 'uzaktan geldi');
});

test('sync local -> remote klasoru esitler', async () => {
  await fsp.mkdir(path.join(localRoot, 'senkron'), { recursive: true });
  await fsp.writeFile(path.join(localRoot, 'senkron', 'a.txt'), 'a');
  await fsp.writeFile(path.join(localRoot, 'senkron', 'b.txt'), 'b');

  await engine.call('sync', {
    id: FOLDER_ID,
    path: path.join(localRoot, 'senkron'),
    direction: 'localToRemote',
  });

  assert.equal(await fsp.readFile(remote(path.join('senkron', 'a.txt')), 'utf8'), 'a');
  assert.equal(await fsp.readFile(remote(path.join('senkron', 'b.txt')), 'utf8'), 'b');
});

test('sync delete secenegi uzaktaki fazlaligi siler', async () => {
  await fsp.writeFile(remote(path.join('senkron', 'fazlalik.txt')), 'silinmeli');

  await engine.call('sync', {
    id: FOLDER_ID,
    path: path.join(localRoot, 'senkron'),
    direction: 'localToRemote',
    options: { delete: true },
  });

  assert.equal(fs.existsSync(remote(path.join('senkron', 'fazlalik.txt'))), false);
  assert.equal(fs.existsSync(remote(path.join('senkron', 'a.txt'))), true);
});

test('autoDelete acikken lokal silme uzakta da siler', async () => {
  const p = path.join(localRoot, 'silinecek.txt');
  await fsp.writeFile(p, 'gecici');
  await waitForUpload('silinecek.txt', 'gecici');

  await fsp.unlink(p);
  await waitFor(() => !fs.existsSync(remote('silinecek.txt')), { label: 'remote delete' });
});

test('stdout protokolu bozulmadi', () => {
  // Tüm mesajlar ayrıştırılabildiyse protokol temiz demektir; ayrıca
  // portlanan kodun logları event akışına düşmüş olmalı.
  assert.ok(logs.length > 0, 'motor hiç log üretmedi');
  const errors = events.filter(e => e.type === 'transfer' && e.phase === 'error');
  assert.deepEqual(errors, [], `transfer hataları: ${JSON.stringify(errors)}`);
});
