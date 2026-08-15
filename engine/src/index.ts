// ÖNEMLİ: stdout satır ayraçlı JSON-RPC'ye ayrılmıştır.
// Portlanan ~4.5k satırdaki herhangi bir console.log protokolü bozar,
// bu yüzden her şeyden önce console stderr'e yönlendiriliyor.
const toStderr = (...args: any[]) => {
  process.stderr.write(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
};
console.log = toStderr;
console.info = toStderr;
console.warn = toStderr;
console.debug = toStderr;

import { RpcPeer } from './rpc';
import { Folder, FolderEvent } from './folder';
import { setLogSink, formatArgs } from './shims/logger';
import { setPasswordResolver } from './shims/host';
import { setStatusSink } from './shims/app';
import { SyncDirection } from './operations';

const rpc = new RpcPeer(process.stdin, process.stdout);
const folders = new Map<string, Folder>();

setLogSink((level, args) => {
  rpc.notify('log', { level, message: formatArgs(args) });
});

// Şifre soruları arayüze iletilir; motor hiçbir şifreyi diske yazmaz.
const pendingPasswords = new Map<number, (value: string | undefined) => void>();
let passwordSeq = 0;
setPasswordResolver((prompt, account) => {
  const requestId = ++passwordSeq;
  return new Promise<string | undefined>(resolve => {
    pendingPasswords.set(requestId, resolve);
    rpc.notify('password:request', { requestId, prompt, account: account ?? null });
  });
});

rpc.on('password:response', ({ requestId, password }) => {
  const resolve = pendingPasswords.get(requestId);
  if (resolve) {
    pendingPasswords.delete(requestId);
    resolve(password ?? undefined);
  }
});

setStatusSink(message => {
  rpc.notify('connection', { message });
});

function emit(event: FolderEvent) {
  rpc.notify('event', event);
}

function requireFolder(id: string): Folder {
  const folder = folders.get(id);
  if (!folder) {
    throw new Error(`Unknown folder: ${id}`);
  }
  return folder;
}

rpc.on('ping', () => ({ pong: true, pid: process.pid }));

rpc.on('addFolder', async ({ id, path: workspace, configPath, profile, enabled }) => {
  if (folders.has(id)) {
    await folders.get(id)!.dispose();
  }
  const folder = new Folder({ id, workspace, configPath, profile, enabled }, emit);
  folders.set(id, folder);
  await folder.load();
  return folder.status;
});

rpc.on('removeFolder', async ({ id }) => {
  const folder = folders.get(id);
  if (folder) {
    await folder.dispose();
    folders.delete(id);
  }
  return null;
});

rpc.on('reloadFolder', async ({ id }) => {
  const folder = requireFolder(id);
  await folder.load();
  return folder.status;
});

rpc.on('setEnabled', async ({ id, enabled }) => {
  const folder = requireFolder(id);
  await folder.setEnabled(Boolean(enabled));
  return folder.status;
});

rpc.on('setProfile', async ({ id, profile }) => {
  const folder = requireFolder(id);
  await folder.setProfile(profile ?? null);
  return folder.status;
});

rpc.on('status', () => ({
  pid: process.pid,
  folders: Array.from(folders.values()).map(f => f.status),
}));

rpc.on('upload', async ({ id, path: target }) => {
  await requireFolder(id).upload(target);
  return null;
});

rpc.on('download', async ({ id, path: target }) => {
  await requireFolder(id).download(target);
  return null;
});

rpc.on('sync', async ({ id, path: target, direction, options }) => {
  const deleted = await requireFolder(id).sync(
    target,
    (direction ?? 'localToRemote') as SyncDirection,
    options ?? {}
  );
  return { deleted: Array.isArray(deleted) ? deleted.map((d: any) => d.fspath) : [] };
});

rpc.on('removeRemote', async ({ id, path: target }) => {
  const removed = await requireFolder(id).removeRemote(target);
  return { removed };
});

rpc.on('cancel', ({ id }) => {
  requireFolder(id).cancel();
  return null;
});

rpc.on('shutdown', async () => {
  for (const folder of folders.values()) {
    await folder.dispose();
  }
  folders.clear();
  setTimeout(() => process.exit(0), 50);
  return null;
});

// Ebeveyn (uygulama) çökerse ya da zorla kapatılırsa stdin kapanır.
// Bunu dinlemezsek motor yetim kalıp klasörleri izlemeye ve dosya
// yüklemeye devam ediyor - görünmez bir ikinci yükleyici.
let shuttingDown = false;

async function shutdownAndExit(reason: string) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  process.stderr.write(`shutting down: ${reason}\n`);

  // Sert son tarih. Temizlik ölü bir SSH bağlantısını kapatmayı beklerken
  // asılı kalabiliyor; o zaman süreç hiç kapanmıyor ve arkada görünmez bir
  // yükleyici olarak yaşamaya devam ediyor. Ne olursa olsun çıkıyoruz.
  setTimeout(() => process.exit(0), 2000);

  try {
    await Promise.all(
      Array.from(folders.values()).map(folder =>
        folder.dispose().catch(() => {
          /* kapanışta hatayı yut */
        })
      )
    );
  } catch {
    /* yut */
  }
  folders.clear();
  process.exit(0);
}

process.stdin.on('end', () => {
  void shutdownAndExit('stdin closed (parent gone)');
});
process.stdin.on('close', () => {
  void shutdownAndExit('stdin closed (parent gone)');
});

// stdin EOF'una tek başına güvenilemiyor. Swift tarafı motoru Foundation
// Process ile başlatıyor ve boru uçlarının miras alınma biçimi yüzünden
// ebeveyn SIGKILL ile öldüğünde stdin kapanmayabiliyor - motor arkada
// görünmez bir yükleyici olarak kalıyor.
//
// Ebeveyn ölünce süreç launchd'ye (pid 1) devredilir; bunu yoklamak
// güvenilir ve ucuz.
const initialParent = process.ppid;
const parentWatch = setInterval(() => {
  if (process.ppid !== initialParent || process.ppid === 1) {
    clearInterval(parentWatch);
    void shutdownAndExit(`parent gone (ppid ${initialParent} → ${process.ppid})`);
  }
}, 2000);
parentWatch.unref();
process.on('SIGTERM', () => void shutdownAndExit('SIGTERM'));
process.on('SIGHUP', () => void shutdownAndExit('SIGHUP'));

process.on('uncaughtException', error => {
  rpc.notify('log', { level: 'critical', message: `uncaught: ${error.stack ?? error.message}` });
});

process.on('unhandledRejection', reason => {
  rpc.notify('log', { level: 'error', message: `unhandled rejection: ${String(reason)}` });
});

rpc.notify('ready', { pid: process.pid });
