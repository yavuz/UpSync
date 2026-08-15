import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'fs/promises';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { startSftpServer } from './sftp-server.mjs';
import { startEngine, waitFor } from './client.mjs';

// dev4'ün .vscode/sftp.json dosyasındaki gerçek ignore listesi.
// Kurallar gitignore semantiğiyle değerlendirilir ("ignore" npm paketi).
const IGNORE = [
  '**/.vscode/**', '**/.cursor/**', '**/.idea/**', '**/.claude/**',
  '**/.codex/**', '**/.context/**', '**/.docker/**', '**/.git/**',
  '**/docs/**', '**/prototypes/**', 'crns/tests/**',
  '**/package/vendor/**', '**/node_modules/**', '**/templates_c/**',
  '**/cache/**', '**/logs/**', '**/var/temp-log/**', '**/media/**',
  '**/.DS_Store', '**/.env', '**/.env.*',
  'includes/env.local.php', 'includes/env.local.tmp.php',
  'includes/env.cron.php', 'includes/env.cron.tmp.php',
  'autosync.sh', 'CLAUDE.md', 'AGENTS.md', 'init.md',
  '.gitignore', '.claudeignore', 'dbhub.toml', 'tools.yaml',
  'docker-compose.yml', 'docker-compose.*.yml',
  '**/*.log', '**/*.log.*', '**/*.sql.dump', '**/*.dump',
  '**/*.bak', '**/*.tmp', '**/*.swp', '**/*.swo', '**/*~',
];

// [göreli yol, yüklenmeli mi, hangi kural]
const CASES = [
  // --- yüklenmeli ---
  ['index.php', true, 'normal dosya'],
  ['app/views/home.tpl', true, 'alt klasör, .tpl'],
  ['crns/lib/Helper.php', true, 'crns altında ama tests değil'],
  ['includes/env.php', true, 'env.local.php değil'],
  ['assets/style.css', true, 'normal varlık'],
  ['docker-compose.override.yaml', true, 'yml değil yaml'],
  ['media_kit/logo.svg', true, 'media_kit ≠ media'],

  // --- ignore edilmeli: dizin kalıpları ---
  ['node_modules/paket/index.js', false, '**/node_modules/**'],
  ['package/vendor/lib/a.php', false, '**/package/vendor/**'],
  ['templates_c/derlenmis.php', false, '**/templates_c/**'],
  ['cache/onbellek.dat', false, '**/cache/**'],
  ['var/cache/ic.dat', false, '**/cache/** iç içe'],
  ['logs/erisim.txt', false, '**/logs/**'],
  ['var/temp-log/x.txt', false, '**/var/temp-log/**'],
  ['media/resim.jpg', false, '**/media/**'],
  ['docs/kilavuz.md', false, '**/docs/**'],
  ['prototypes/deneme.php', false, '**/prototypes/**'],
  ['crns/tests/UnitTest.php', false, 'crns/tests/**'],
  ['.vscode/sftp.json', false, '**/.vscode/**'],
  ['.claude/ayar.json', false, '**/.claude/**'],
  ['.docker/Dockerfile', false, '**/.docker/**'],

  // --- ignore edilmeli: dosya kalıpları ---
  ['hata.log', false, '**/*.log'],
  ['alt/dizin/hata.log', false, '**/*.log derinlemesine'],
  ['erisim.log.1', false, '**/*.log.*'],
  ['yedek.sql.dump', false, '**/*.sql.dump'],
  ['veri.dump', false, '**/*.dump'],
  ['eski.bak', false, '**/*.bak'],
  ['gecici.tmp', false, '**/*.tmp'],
  ['dosya.swp', false, '**/*.swp'],
  ['yedek~', false, '**/*~'],
  ['.env', false, '**/.env'],
  ['.env.production', false, '**/.env.*'],

  // --- ignore edilmeli: tam yol / çıplak isim ---
  ['includes/env.local.php', false, 'tam göreli yol'],
  ['includes/env.cron.php', false, 'tam göreli yol'],
  ['autosync.sh', false, 'çıplak isim'],
  ['CLAUDE.md', false, 'çıplak isim'],
  ['docker-compose.yml', false, 'çıplak isim'],
  ['docker-compose.prod.yml', false, 'docker-compose.*.yml'],
  ['.gitignore', false, 'çıplak isim'],
  ['tools.yaml', false, 'çıplak isim'],

  // gitignore semantiği: çıplak isim HER seviyede eşleşir
  ['alt/klasor/CLAUDE.md', false, 'çıplak isim alt dizinde de geçerli'],
];

let server;
let engine;
let localRoot;
let remoteRoot;
const events = [];

before(async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upsync-ign-'));
  localRoot = path.join(tmp, 'local');
  remoteRoot = path.join(tmp, 'remote');
  await fsp.mkdir(localRoot, { recursive: true });
  await fsp.mkdir(remoteRoot, { recursive: true });

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
      // dev4'teki gibi: uploadOnSave kapalı ama watcher.autoUpload açık
      uploadOnSave: false,
      watcher: { autoUpload: true, autoDelete: false },
      ignore: ['.zed/**', ...IGNORE],
    })
  );

  engine = startEngine({ onEvent: e => events.push(e) });
  const status = await engine.call('addFolder', { id: 'ign', path: localRoot });
  assert.equal(status.error, null, `config hatası: ${status.error}`);
  assert.equal(status.autoUpload, true, 'watcher.autoUpload tek başına izlemeyi açmalı');

  await waitFor(() => events.some(e => e.type === 'watcher' && e.state === 'ready'), {
    label: 'watcher ready',
  });

  // Tüm örnek dosyaları yaz.
  for (const [rel] of CASES) {
    const full = path.join(localRoot, rel);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, `icerik: ${rel}`);
  }

  // Yüklenmesi beklenen son dosya geldiğinde izleyici tüm olayları işlemiştir.
  const expected = CASES.filter(([, ok]) => ok).map(([rel]) => rel);
  await waitFor(
    () => expected.every(rel => fs.existsSync(path.join(remoteRoot, rel))),
    { label: 'beklenen yüklemeler', timeout: 30000 }
  );
  // Ignore edilenlerin yanlışlıkla geç gelmediğinden emin olmak için kısa pay.
  await new Promise(r => setTimeout(r, 1500));
});

after(async () => {
  await engine?.stop();
  await server?.close();
});

for (const [rel, shouldUpload, rule] of CASES) {
  test(`${shouldUpload ? 'yüklenir' : 'atlanır'}: ${rel}  (${rule})`, () => {
    const exists = fs.existsSync(path.join(remoteRoot, rel));
    assert.equal(
      exists,
      shouldUpload,
      shouldUpload
        ? `${rel} yüklenmeliydi ama uzakta yok`
        : `${rel} ignore edilmeliydi ama uzağa yüklendi`
    );
  });
}

test('manuel klasör yüklemesinde de ignore uygulanır', async () => {
  // İzleyiciden bağımsız yol: transfer katmanının kendi ignore kontrolü.
  await fsp.rm(remoteRoot, { recursive: true, force: true });
  await fsp.mkdir(remoteRoot, { recursive: true });

  await engine.call('upload', { id: 'ign', path: localRoot });

  for (const [rel, shouldUpload] of CASES) {
    assert.equal(
      fs.existsSync(path.join(remoteRoot, rel)),
      shouldUpload,
      `manuel upload: ${rel}`
    );
  }
});
