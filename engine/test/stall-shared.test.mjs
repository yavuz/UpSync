import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'fs/promises';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { startSftpServer } from './sftp-server.mjs';
import { startEngine, waitFor } from './client.mjs';

// Regresyon: ilk stall-guard tasarımı her transferin KENDİ izole
// zamanlayıcısına bakıyordu. Birden fazla dosya aynı bağlantıyı
// paylaşırken (concurrency > 1, ya da art arda ayrı upload çağrıları)
// biri - bağlantı canlı olsa bile, sadece diğerlerinin arkasında sırada
// beklediği için - kendi payına düşen sürede sessiz kalırsa bağlantının
// TAMAMI kapatılıyor, o an giden diğer sağlıklı dosyalar da yanında
// gidiyordu. Gerçek dünyada bu, bir "task" birden çok dosyayı aynı anda
// değiştirdiğinde bazı dosyaların hiç yüklenmemesi olarak görünüyordu.
//
// Bu testler: (a) bağlantı GERÇEKTEN meşgulken (başka dosyalar akarken)
// yavaş bir dosyanın öldürülmediğini, gecikme bitince başarıyla
// tamamlandığını, ve o sırada giden diğer dosyaların etkilenmediğini,
// (b) hiçbir dosya ilerlemiyorsa (gerçekten ölü bağlantı) tespitin hâlâ
// çalıştığını doğruluyor.

let server, engine, localRoot, remoteRoot;

before(async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upsync-stall-shared-'));
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

  // Stall eşiği kısa (1.5s); yavaş dosya bundan UZUN gecikiyor (4s) ama
  // sonunda yanıt veriyor - "ölü değil, meşgul" senaryosu.
  process.env.UPSYNC_STALL_TIMEOUT_MS = '1500';
  process.env.UPSYNC_TEST_DELAY_FILE = 'slow.php';
  process.env.UPSYNC_TEST_DELAY_MS = '4000';

  engine = startEngine({});
  await engine.call('addFolder', { id: 's', path: localRoot });
});

after(async () => {
  await engine?.stop();
  await server?.close();
  delete process.env.UPSYNC_STALL_TIMEOUT_MS;
  delete process.env.UPSYNC_TEST_DELAY_FILE;
  delete process.env.UPSYNC_TEST_DELAY_MS;
});

test('baglanti mesgulken yavas dosya oldurulmez, digerleri de etkilenmez', async () => {
  const slow = path.join(localRoot, 'slow.php');
  await fsp.writeFile(slow, '<?php // yavas');

  const fastFiles = ['a.php', 'b.php', 'c.php', 'd.php'].map(n => path.join(localRoot, n));
  for (const f of fastFiles) await fsp.writeFile(f, `<?php // ${path.basename(f)}`);

  // Yavaş dosyanın gecikmesi (4s) boyunca bağlantıyı sürekli meşgul tut:
  // stall eşiğinden (1.5s) daha sık aralıklarla hızlı dosyaları tekrar
  // yükle, ki paylaşılan "son etkinlik" damgası hep tazelensin.
  const keepBusy = (async () => {
    const deadline = Date.now() + 3500;
    while (Date.now() < deadline) {
      await Promise.all(fastFiles.map(f => engine.call('upload', { id: 's', path: f })));
      await new Promise(r => setTimeout(r, 300));
    }
  })();

  const slowUpload = engine.call('upload', { id: 's', path: slow });

  await Promise.all([keepBusy, slowUpload]);

  // Yavaş dosya sonunda gerçekten gitmiş olmalı - öldürülmüş olsaydı
  // uzakta hiç görünmezdi.
  await waitFor(() => fs.existsSync(path.join(remoteRoot, 'slow.php')), {
    label: 'yavas dosya nihayetinde yuklenmeli',
    timeout: 8000,
  });
  assert.equal(await fsp.readFile(path.join(remoteRoot, 'slow.php'), 'utf8'), '<?php // yavas');

  // Meşgul tutma sırasında giden hızlı dosyalar da etkilenmemiş olmalı.
  for (const f of fastFiles) {
    const name = path.basename(f);
    assert.ok(fs.existsSync(path.join(remoteRoot, name)), `${name} da gitmis olmali`);
  }
});

test('hicbir dosya ilerlemiyorsa (gercek olu baglanti) tespit hala calisir', async () => {
  process.env.UPSYNC_TEST_STALL_FILE = 'gercek-olu.php';
  const p = path.join(localRoot, 'gercek-olu.php');
  await fsp.writeFile(p, '<?php // olu');

  const events = [];
  // Bu testte ayrı bir event dinleyicisi lazım; engine zaten çalışıyor,
  // onEvent callback'i ilk startEngine çağrısında sabitlendiği için
  // burada durumu RPC'nin kendisinden (hata fırlatmasa bile süresinden)
  // ölçüyoruz: RPC "upload" her zaman resolve olur (hata event'le gelir),
  // o yüzden dogrudan dosyanin GITMEDIGINI ve makul surede vazgecildigini
  // kontrol ediyoruz.
  const t0 = Date.now();
  await engine.call('upload', { id: 's', path: p });
  const elapsed = Date.now() - t0;

  assert.ok(elapsed < 6000, `tespit calismali, ${elapsed}ms surdu`);
  // OPEN, WRITE hiç onaylanmasa bile dosyayı sıfır bayt olarak oluşturuyor;
  // bu yüzden varlık değil İÇERİK kontrol ediliyor - asıl dosyanın hiç
  // yazılmadığının kanıtı bu.
  const remotePath = path.join(remoteRoot, 'gercek-olu.php');
  const wroteContent = fs.existsSync(remotePath) && fs.readFileSync(remotePath, 'utf8') === '<?php // olu';
  assert.equal(wroteContent, false, 'stall tespit edilmeden icerik yazilmis olmamali');

  delete process.env.UPSYNC_TEST_STALL_FILE;

  // Baglanti toparlanmis olmali: ayni dosyayi tekrar dene, bu sefer
  // stall bayragi kapali oldugu icin basarili gitmeli.
  await engine.call('upload', { id: 's', path: p });
  await waitFor(
    () => fs.existsSync(remotePath) && fs.readFileSync(remotePath, 'utf8') === '<?php // olu',
    { label: 'toparlanma sonrasi yukleme', timeout: 8000 }
  );
});
