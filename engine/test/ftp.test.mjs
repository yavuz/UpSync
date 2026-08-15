import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'fs/promises';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { FtpSrv } from 'ftp-srv';
import { startEngine, waitFor } from './client.mjs';

// Sabit port, art arda koşularda "adres kullanımda" hatasına yol açıyordu.
// İşletim sisteminden boş port isteyip serbest bırakıyoruz.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

let ftpServer;
let engine;
let localRoot;
let remoteRoot;
const events = [];

const FOLDER_ID = 'ftp1';
const USER = 'test';
const PASS = 'test';

before(async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'upsync-ftp-'));
  localRoot = path.join(tmp, 'local');
  remoteRoot = path.join(tmp, 'remote');
  await fsp.mkdir(localRoot, { recursive: true });
  await fsp.mkdir(remoteRoot, { recursive: true });

  const port = await freePort();
  // Pasif aralık da kontrol portundan türetiliyor ki koşular çakışmasın.
  const pasvMin = port + 1;
  const pasvMax = port + 20;
  ftpServer = new FtpSrv({
    url: `ftp://127.0.0.1:${port}`,
    pasv_url: '127.0.0.1',
    pasv_min: pasvMin,
    pasv_max: pasvMax,
    anonymous: false,
  });
  ftpServer.on('login', ({ username, password }, resolve, reject) => {
    if (username === USER && password === PASS) {
      resolve({ root: remoteRoot });
    } else {
      reject(new Error('bad credentials'));
    }
  });
  await ftpServer.listen();

  await fsp.mkdir(path.join(localRoot, '.zed'), { recursive: true });
  await fsp.writeFile(
    path.join(localRoot, '.zed', 'sftp.json'),
    JSON.stringify({
      name: 'ftp-test',
      protocol: 'ftp',
      host: '127.0.0.1',
      port,
      username: USER,
      password: PASS,
      remotePath: '/',
      uploadOnSave: true,
      ignore: ['.zed/**'],
    })
  );

  engine = startEngine({ onEvent: e => events.push(e) });
  const status = await engine.call('addFolder', { id: FOLDER_ID, path: localRoot });
  assert.equal(status.error, null, `config yüklenemedi: ${status.error}`);
  assert.equal(status.protocol, 'ftp');

  await waitFor(() => events.some(e => e.type === 'watcher' && e.state === 'ready'), {
    label: 'watcher ready',
  });
});

after(async () => {
  await engine?.stop();
  await ftpServer?.close();
});

test('ftp: kaydedilen dosya otomatik yüklenir', async () => {
  await fsp.writeFile(path.join(localRoot, 'index.html'), '<h1>ftp</h1>');
  await waitFor(() => fs.existsSync(path.join(remoteRoot, 'index.html')), {
    label: 'ftp upload',
  });
  assert.equal(await fsp.readFile(path.join(remoteRoot, 'index.html'), 'utf8'), '<h1>ftp</h1>');
});

test('ftp: manuel upload ve download', async () => {
  const p = path.join(localRoot, 'manuel.txt');
  await fsp.writeFile(p, 'ftp manuel');
  await engine.call('upload', { id: FOLDER_ID, path: p });
  assert.equal(await fsp.readFile(path.join(remoteRoot, 'manuel.txt'), 'utf8'), 'ftp manuel');

  await fsp.writeFile(path.join(remoteRoot, 'uzak.txt'), 'uzaktan');
  const target = path.join(localRoot, 'uzak.txt');
  await engine.call('download', { id: FOLDER_ID, path: target });
  assert.equal(await fsp.readFile(target, 'utf8'), 'uzaktan');
});

test('ftp: klasor sync', async () => {
  await fsp.mkdir(path.join(localRoot, 'dizin'), { recursive: true });
  await fsp.writeFile(path.join(localRoot, 'dizin', 'x.txt'), 'x');
  await engine.call('sync', {
    id: FOLDER_ID,
    path: path.join(localRoot, 'dizin'),
    direction: 'localToRemote',
  });
  assert.equal(await fsp.readFile(path.join(remoteRoot, 'dizin', 'x.txt'), 'utf8'), 'x');
});

test('ftp: transfer hatasi yok', () => {
  const errors = events.filter(e => e.type === 'transfer' && e.phase === 'error');
  assert.deepEqual(errors, [], `transfer hataları: ${JSON.stringify(errors)}`);
});
