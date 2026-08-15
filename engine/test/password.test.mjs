import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'fs/promises';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { startSftpServer } from './sftp-server.mjs';
import { startEngine, waitFor } from './client.mjs';

let server;
let engine;
let localRoot;
let remoteRoot;
const passwordRequests = [];
const events = [];

before(async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upsync-pw-'));
  localRoot = path.join(tmp, 'local');
  remoteRoot = path.join(tmp, 'remote');
  await fsp.mkdir(localRoot, { recursive: true });
  await fsp.mkdir(remoteRoot, { recursive: true });

  server = await startSftpServer({ root: remoteRoot, username: 'kullanici', password: 'gizli' });

  await fsp.mkdir(path.join(localRoot, '.zed'), { recursive: true });
  await fsp.writeFile(
    path.join(localRoot, '.zed', 'sftp.json'),
    JSON.stringify({
      host: '127.0.0.1',
      port: server.port,
      protocol: 'sftp',
      username: 'kullanici',
      // true = "şifreyi config'te tutma, arayüzden/Keychain'den al"
      password: true,
      remotePath: '/',
      uploadOnSave: true,
      ignore: ['.zed/**'],
    })
  );

  // Swift arayüzünün yerine geçiyoruz: isteği yakala, Keychain'den geliyormuş
  // gibi yanıtla.
  engine = startEngine({
    onEvent: e => events.push(e),
    onNotify: (method, params) => {
      if (method !== 'password:request') return;
      passwordRequests.push(params);
      engine.notify('password:response', {
        requestId: params.requestId,
        password: 'gizli',
      });
    },
  });

  await engine.call('addFolder', { id: 'pw', path: localRoot });

  // İzleyici hazır olmadan dosya yazarsak olay hiç gelmez; diğer testlerdeki
  // gibi burada da bekliyoruz.
  await waitFor(() => events.some(e => e.type === 'watcher' && e.state === 'ready'), {
    label: 'watcher ready',
  });
});

after(async () => {
  await engine?.stop();
  await server?.close();
});

test('password: true iken sifre arayuze sorulur ve baglanti kurulur', async () => {
  await fsp.writeFile(path.join(localRoot, 'gizli.txt'), 'sifreli yukleme');

  await waitFor(() => fs.existsSync(path.join(remoteRoot, 'gizli.txt')), {
    label: 'sifre sorulup yukleme tamamlanmali',
  });

  assert.equal(await fsp.readFile(path.join(remoteRoot, 'gizli.txt'), 'utf8'), 'sifreli yukleme');
  assert.ok(passwordRequests.length > 0, 'motor sifre istemedi');
});

test('sifre istegi Keychain icin hesap kimligi tasir', () => {
  assert.match(passwordRequests[0].account, /^kullanici@127\.0\.0\.1:\d+$/);
});

test('yanlis sifre sessizce basarisiz olmaz', async () => {
  // Aynı motorda ikinci bir klasör, bilerek yanlış şifre veren bir arayüzle.
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upsync-pw2-'));
  const local2 = path.join(tmp, 'local');
  await fsp.mkdir(path.join(local2, '.zed'), { recursive: true });
  await fsp.writeFile(
    path.join(local2, '.zed', 'sftp.json'),
    JSON.stringify({
      host: '127.0.0.1',
      port: server.port,
      protocol: 'sftp',
      username: 'kullanici',
      password: 'yanlis-sifre',
      remotePath: '/',
      uploadOnSave: false,
      ignore: ['.zed/**'],
    })
  );

  await engine.call('addFolder', { id: 'pw2', path: local2 });
  await fsp.writeFile(path.join(local2, 'a.txt'), 'x');

  await assert.rejects(
    () => engine.call('upload', { id: 'pw2', path: path.join(local2, 'a.txt') }),
    /.+/,
    'yanlış şifreyle upload hata vermeliydi'
  );
});
