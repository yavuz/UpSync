import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'fs/promises';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { startSftpServer } from './sftp-server.mjs';
import { startEngine, waitFor } from './client.mjs';

// İzin ve değiştirilme zamanı uzak tarafa doğru yazılıyor mu?
// Bu iki öznitelik tek bir FSETSTAT paketinde birleştirildi; içerik
// testleri bunu yakalamaz, o yüzden ayrı doğrulanıyor.

let server, engine, localRoot, remoteRoot;
const events = [];

before(async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upsync-attrs-'));
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
      remotePath: '/', uploadOnSave: true, ignore: ['.zed/**'],
    })
  );

  engine = startEngine({ onEvent: e => events.push(e) });
  await engine.call('addFolder', { id: 'a', path: localRoot });
  await waitFor(() => events.some(e => e.type === 'watcher' && e.state === 'ready'), {
    label: 'watcher ready',
  });
});

after(async () => {
  await engine?.stop();
  await server?.close();
});

test('degistirilme zamani uzak tarafa korunur', async () => {
  const local = path.join(localRoot, 'zaman.php');
  await fsp.writeFile(local, '<?php // zaman');

  // Belirgin bir geçmiş tarih ver
  const when = new Date('2026-03-04T05:06:07Z');
  await fsp.utimes(local, when, when);
  // izleyiciyi tekrar tetikle
  await fsp.appendFile(local, '\n');
  await fsp.utimes(local, when, when);

  await waitFor(() => fs.existsSync(path.join(remoteRoot, 'zaman.php')), { label: 'yukleme' });
  await waitFor(
    () => Math.abs(fs.statSync(path.join(remoteRoot, 'zaman.php')).mtimeMs - when.getTime()) < 2000,
    { label: 'mtime aktarimi', timeout: 15000 }
  );

  const remoteStat = await fsp.stat(path.join(remoteRoot, 'zaman.php'));
  assert.ok(
    Math.abs(remoteStat.mtimeMs - when.getTime()) < 2000,
    `uzak mtime ${new Date(remoteStat.mtimeMs).toISOString()}, beklenen ${when.toISOString()}`
  );
});

test('filePerm ayarlandiginda uzak izin uygulanir', async () => {
  // filePerm config'i ayrı bir klasörle test ediliyor
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upsync-perm-'));
  const l2 = path.join(tmp, 'local'), r2 = path.join(tmp, 'remote');
  await fsp.mkdir(path.join(l2, '.zed'), { recursive: true });
  await fsp.mkdir(r2, { recursive: true });
  const srv2 = await startSftpServer({ root: r2 });
  await fsp.writeFile(
    path.join(l2, '.zed', 'sftp.json'),
    JSON.stringify({
      host: '127.0.0.1', port: srv2.port, protocol: 'sftp',
      username: srv2.username, password: srv2.password,
      remotePath: '/', uploadOnSave: false, ignore: ['.zed/**'],
      filePerm: 640,
    })
  );
  await engine.call('addFolder', { id: 'perm', path: l2, enabled: false });

  const p = path.join(l2, 'gizli.php');
  await fsp.writeFile(p, '<?php // izin');
  await engine.call('upload', { id: 'perm', path: p });

  const mode = (await fsp.stat(path.join(r2, 'gizli.php'))).mode & 0o777;
  assert.equal(mode.toString(8), '640', `uzak izin ${mode.toString(8)}, beklenen 640`);

  await engine.call('removeFolder', { id: 'perm' });
  await srv2.close();
  await fsp.rm(tmp, { recursive: true, force: true });
});
