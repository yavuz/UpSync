import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'fs/promises';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { startSftpServer } from './sftp-server.mjs';
import { startBlackholeProxy } from './blackhole-proxy.mjs';
import { startEngine, waitForContent } from './client.mjs';

// "Yirmi dakika ara verdim, döndüğümde dosyalar artık gitmiyor" senaryosu:
// boşta kalan bağlantı ağ tarafında sessizce düşürülüyor - ne FIN ne RST,
// soket 'close' üretmiyor. Motor bunu fark edip yeni bir bağlantı kurmazsa
// havuzdaki ölü bağlantı "geçerli" sanılmaya devam ediyor ve yüklemeler
// hiçbir hata bile üretmeden asılı kalıyor.

let server, proxy, engine, localRoot, remoteRoot;

before(async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upsync-idle-death-'));
  localRoot = path.join(tmp, 'local');
  remoteRoot = path.join(tmp, 'remote');
  await fsp.mkdir(localRoot, { recursive: true });
  await fsp.mkdir(remoteRoot, { recursive: true });

  server = await startSftpServer({ root: remoteRoot });
  // Motor sunucuya bu aracı üzerinden bağlanıyor; aracı bağlantıyı ağ
  // seviyesinde kara deliğe çevirebiliyor.
  proxy = await startBlackholeProxy(server.port);

  await fsp.mkdir(path.join(localRoot, '.zed'), { recursive: true });
  await fsp.writeFile(
    path.join(localRoot, '.zed', 'sftp.json'),
    JSON.stringify({
      host: '127.0.0.1', port: proxy.port, protocol: 'sftp',
      username: server.username, password: server.password,
      remotePath: '/', uploadOnSave: false, ignore: ['.zed/**'],
      connectTimeout: 5000,
    })
  );

  // Gerçekte eşik bir dakika; testte "uzun süre boşta kalmış bağlantı"
  // durumunu beklemeden kurabilmek için kısaltılıyor.
  process.env.UPSYNC_IDLE_PROBE_AFTER_MS = '200';
  process.env.UPSYNC_STALL_TIMEOUT_MS = '1000';
  engine = startEngine({});
  await engine.call('addFolder', { id: 'd', path: localRoot });
});

after(async () => {
  await engine?.stop();
  await proxy?.close();
  await server?.close();
  delete process.env.UPSYNC_IDLE_PROBE_AFTER_MS;
  delete process.env.UPSYNC_STALL_TIMEOUT_MS;
});

test('bosta olen baglanti: sonraki yukleme yeni baglantiyla gider', async () => {
  const first = path.join(localRoot, 'ilk.php');
  await fsp.writeFile(first, '<?php // ilk');
  await engine.call('upload', { id: 'd', path: first });
  assert.equal(fs.existsSync(path.join(remoteRoot, 'ilk.php')), true);

  // Bağlantı boştayken ağ tarafında düşürülüyor.
  proxy.blackholeExisting();
  await new Promise(r => setTimeout(r, 400)); // "boşta kalma" eşiğini aş

  const second = path.join(localRoot, 'ikinci.php');
  await fsp.writeFile(second, '<?php // ikinci');
  const t0 = Date.now();
  await engine.call('upload', { id: 'd', path: second });
  const elapsed = Date.now() - t0;

  await waitForContent(fs, path.join(remoteRoot, 'ikinci.php'), '<?php // ikinci', {
    label: 'olu baglanti sonrasi yukleme',
    timeout: 10000,
  });
  // Yoklama + yeniden bağlanma: saniyeler, dakikalar değil.
  assert.ok(elapsed < 15000, `${elapsed}ms surdu`);
});

test('kullanimdayken olen baglanti havuzu zehirlemez', async () => {
  // Bu sefer bağlantı "boşta" sayılmayacak kadar taze ölüyor: yükleme
  // yanıtsız kalıyor ve ancak keepalive zaman aşımıyla hata veriyor.
  // Önemli olan, ondan SONRAKİ yüklemenin çalışması - eskiden havuzda
  // ölü bağlantı geçerli kalabiliyor ve her şey sessizce asılıyordu.
  process.env.UPSYNC_IDLE_PROBE_AFTER_MS = '3600000';
  await engine.call('reloadFolder', { id: 'd' });

  const warm = path.join(localRoot, 'isinma.php');
  await fsp.writeFile(warm, '<?php // isinma');
  await engine.call('upload', { id: 'd', path: warm });

  proxy.blackholeExisting();

  const dead = path.join(localRoot, 'olu.php');
  await fsp.writeFile(dead, '<?php // olu');
  const t0 = Date.now();
  await engine.call('upload', { id: 'd', path: dead }).catch(() => {});
  const elapsed = Date.now() - t0;
  // keepalive (10sn x 3) + pay: sonsuza kadar asılı kalmamalı.
  assert.ok(elapsed < 60000, `olu baglantidaki yukleme ${elapsed}ms asili kaldi`);

  const after_ = path.join(localRoot, 'sonraki.php');
  await fsp.writeFile(after_, '<?php // sonraki');
  await engine.call('upload', { id: 'd', path: after_ });
  await waitForContent(fs, path.join(remoteRoot, 'sonraki.php'), '<?php // sonraki', {
    label: 'kopustan sonraki yukleme',
    timeout: 15000,
  });
});
