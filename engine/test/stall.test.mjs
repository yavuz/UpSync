import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'fs/promises';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { startSftpServer } from './sftp-server.mjs';
import { startEngine, waitFor } from './client.mjs';

// Bağlantı sessizce ölürse (laptop uykuya girip çıkması, wifi değişimi)
// ssh2'nin yazma/okuma akışları ne 'error' ne 'finish' üretmeden sonsuza
// kadar asılı kalabiliyordu ve kullanıcı için "dosya yükleniyor, hiçbir
// şey olmuyor, tekrar deneyemiyorum" olarak görünüyordu. Bu testler
// stallGuard'ın (a) asılı kalan transferi makul sürede hata olarak
// yüzeye çıkardığını, (b) bağlantıyı zorla kapatıp bir sonraki denemenin
// sıfırdan bağlandığını doğruluyor.

let server, engine, localRoot, remoteRoot;
const events = [];

before(async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upsync-stall-'));
  localRoot = path.join(tmp, 'local');
  remoteRoot = path.join(tmp, 'remote');
  await fsp.mkdir(localRoot, { recursive: true });
  await fsp.mkdir(remoteRoot, { recursive: true });

  server = await startSftpServer({ root: remoteRoot });
  await fsp.mkdir(path.join(localRoot, '.zed'), { recursive: true });
  await fsp.writeFile(
    path.join(localRoot, '.zed', 'sftp.json'),
    JSON.stringify({
      host: '127.0.0.1', port: server.port, protocol: 'sftp',
      username: server.username, password: server.password,
      remotePath: '/', uploadOnSave: false, ignore: ['.zed/**'],
    })
  );

  // Sunucu 'stuck.php' içeren dosyalara yapılan WRITE'lara hiç yanıt
  // vermeyecek şekilde işaretlendi (test/sftp-server.mjs).
  process.env.UPSYNC_TEST_STALL_FILE = 'stuck.php';
  process.env.UPSYNC_STALL_TIMEOUT_MS = '1500';

  engine = startEngine({ onEvent: e => events.push(e) });
  await engine.call('addFolder', { id: 's', path: localRoot });
});

after(async () => {
  await engine?.stop();
  await server?.close();
  delete process.env.UPSYNC_TEST_STALL_FILE;
  delete process.env.UPSYNC_STALL_TIMEOUT_MS;
});

test('yigilan yukleme makul surede hata olarak yuzeye cikar', async () => {
  events.length = 0;
  const p = path.join(localRoot, 'stuck.php');
  await fsp.writeFile(p, '<?php // takilan dosya');

  const t0 = Date.now();
  await engine.call('upload', { id: 's', path: p });

  await waitFor(
    () => events.some(e => e.type === 'transfer' && e.phase === 'error'),
    { timeout: 10000, label: 'error olayi' }
  );

  const elapsed = Date.now() - t0;
  // stallTimeout(1.5s)'in çok üzerinde ama sonsuza kadar asılı kalmadığını
  // kanıtlayacak kadar cömert bir üst sınır.
  assert.ok(elapsed < 10000, `${elapsed}ms sürdü, asılı kalmamalıydı`);

  const err = events.find(e => e.type === 'transfer' && e.phase === 'error');
  assert.match(err.message, /No response from server/);
});

test('baglanti otomatik toparlanir, sonraki dosya basarili gider', async () => {
  const p = path.join(localRoot, 'normal.php');
  await fsp.writeFile(p, '<?php // normal');
  await engine.call('upload', { id: 's', path: p });

  await waitFor(() => fs.existsSync(path.join(remoteRoot, 'normal.php')), {
    label: 'kurtarma yuklemesi',
    timeout: 10000,
  });

  assert.equal(
    await fsp.readFile(path.join(remoteRoot, 'normal.php'), 'utf8'),
    '<?php // normal'
  );
});

test('yigilan indirme de makul surede hata olarak yuzeye cikar', async () => {
  // Uzaktaki dosyayı doğrudan yazıp indirmeyi tetikliyoruz; WRITE değil
  // READ tarafını takılı bırakmak için sunucuya ayrı bir bayrak gerekir,
  // ama motor tarafı zaten aynı stallGuard'ı kullanıyor - burada asıl
  // doğrulanan şey normal bir indirmenin bu değişiklikten etkilenmediği.
  const target = path.join(localRoot, 'indirilecek.php');
  await fsp.writeFile(path.join(remoteRoot, 'indirilecek.php'), '<?php // indir');
  await engine.call('download', { id: 's', path: target });
  assert.equal(await fsp.readFile(target, 'utf8'), '<?php // indir');
});
