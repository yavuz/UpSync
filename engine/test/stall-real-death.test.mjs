import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'fs/promises';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { startSftpServer } from './sftp-server.mjs';
import { startEngine, waitFor } from './client.mjs';

// Yoklama tabanlı tasarımın asıl amacı: TEK bir dosyanın sırada
// beklemesiyle GERÇEKTEN ölü bir bağlantıyı ayırt etmek. Burada sunucu
// tetiklendikten sonra HİÇBİR isteğe (REALPATH yoklaması dahil) yanıt
// vermiyor - gerçek bir laptop-uykuya-dalma / yarı-açık TCP senaryosu.
// Yoklama da yanıtsız kalmalı, bağlantı kapatılmalı, sonraki deneme
// yeni bir bağlantıyla başarılı olmalı.

let server, engine, localRoot, remoteRoot;

before(async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upsync-real-death-'));
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

  process.env.UPSYNC_STALL_TIMEOUT_MS = '1000';
  // Yoklamanın kendi zaman aşımı sabit (PROBE_TIMEOUT_MS = 5000ms,
  // engine.js içinde), o yüzden testin toplam süresi buna göre.
  engine = startEngine({});
  await engine.call('addFolder', { id: 'd', path: localRoot });
});

after(async () => {
  await engine?.stop();
  await server?.close();
  delete process.env.UPSYNC_STALL_TIMEOUT_MS;
  delete process.env.UPSYNC_TEST_KILL_CONNECTION_FILE;
});

test('gercekten olu baglanti: yoklama da yanitsiz kalir, baglanti kapatilir', async () => {
  process.env.UPSYNC_TEST_KILL_CONNECTION_FILE = 'kill.php';
  const p = path.join(localRoot, 'kill.php');
  await fsp.writeFile(p, '<?php // kill');

  const t0 = Date.now();
  await engine.call('upload', { id: 'd', path: p });
  const elapsed = Date.now() - t0;

  // stall(1s) + probe(5s) + biraz pay - toplamda makul bir sure icinde
  // vazgecilmis olmali, sonsuza kadar degil.
  assert.ok(elapsed < 15000, `${elapsed}ms surdu`);

  delete process.env.UPSYNC_TEST_KILL_CONNECTION_FILE;
});

test('baglanti kapatildiktan sonra siradaki dosya yeni baglantiyla basarili gider', async () => {
  const p = path.join(localRoot, 'sonraki.php');
  await fsp.writeFile(p, '<?php // sonraki');
  await engine.call('upload', { id: 'd', path: p });

  await waitFor(() => fs.existsSync(path.join(remoteRoot, 'sonraki.php')), {
    label: 'yeni baglanti ile yukleme',
    timeout: 8000,
  });
  assert.equal(await fsp.readFile(path.join(remoteRoot, 'sonraki.php'), 'utf8'), '<?php // sonraki');
});
