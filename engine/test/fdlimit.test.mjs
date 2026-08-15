import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'fs/promises';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { startSftpServer } from './sftp-server.mjs';
import { startEngine, waitFor } from './client.mjs';

// Regresyon testi: chokidar 4 macOS FSEvents desteğini kaldırmıştı ve dosya
// başına fs.watch açıyordu. `open` ile başlatılan bir uygulama launchd'den
// 256 fd devraldığı için büyük projelerde EMFILE alınıyordu.
// Motoru bilerek 256 fd ile başlatıp geniş bir ağaçta çalıştığını doğruluyoruz.
const DIR_COUNT = 400;
const FD_LIMIT = 256;

let server;
let engine;
let localRoot;
let remoteRoot;
const events = [];
const logs = [];

before(async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upsync-fd-'));
  localRoot = path.join(tmp, 'local');
  remoteRoot = path.join(tmp, 'remote');
  await fsp.mkdir(localRoot, { recursive: true });
  await fsp.mkdir(remoteRoot, { recursive: true });

  // fd limitinin çok üstünde dizin ve dosya üret.
  for (let i = 0; i < DIR_COUNT; i++) {
    const dir = path.join(localRoot, 'mod', `m${i}`, 'src');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'a.php'), `<?php // ${i}`);
    await fsp.writeFile(path.join(dir, 'b.tpl'), `tpl ${i}`);
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
      uploadOnSave: true,
      ignore: ['.zed/**'],
    })
  );

  engine = startEngine({
    onEvent: e => events.push(e),
    onLog: l => logs.push(l),
    fdLimit: FD_LIMIT,
  });

  const status = await engine.call('addFolder', { id: 'fd', path: localRoot });
  assert.equal(status.error, null, `config hatası: ${status.error}`);

  await waitFor(() => events.some(e => e.type === 'watcher' && e.state === 'ready'), {
    label: 'watcher ready (düşük fd limitinde)',
    timeout: 30000,
  });
});

after(async () => {
  await engine?.stop();
  await server?.close();
});

test(`${DIR_COUNT} dizinlik agac ${FD_LIMIT} fd limitinde izlenebiliyor`, () => {
  const emfile = [...events, ...logs].filter(x =>
    JSON.stringify(x).includes('EMFILE')
  );
  assert.deepEqual(emfile, [], `EMFILE hatası alındı: ${JSON.stringify(emfile.slice(0, 2))}`);
});

test('dusuk fd limitinde kaydedilen dosya yine de yuklenir', async () => {
  const target = path.join(localRoot, 'mod', 'm200', 'src', 'yeni.php');
  await fsp.writeFile(target, '<?php echo "fd testi";');

  await waitFor(() => fs.existsSync(path.join(remoteRoot, 'mod/m200/src/yeni.php')), {
    label: 'düşük fd limitinde yükleme',
    timeout: 30000,
  });

  assert.equal(
    await fsp.readFile(path.join(remoteRoot, 'mod/m200/src/yeni.php'), 'utf8'),
    '<?php echo "fd testi";'
  );
});

test('dusuk fd limitinde SSH anahtari da acilabiliyor', () => {
  // Hatanın asıl belirtisi: fd tükendiği için privateKeyPath açılamıyordu.
  const keyErrors = [...events, ...logs].filter(x => {
    const s = JSON.stringify(x);
    return s.includes('EMFILE') && s.includes('open');
  });
  assert.deepEqual(keyErrors, [], 'fd tükenmesi bağlantıyı da etkiledi');
});
