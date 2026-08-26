import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const ENGINE = path.resolve(fileURLToPath(new URL('../dist/engine.js', import.meta.url)));

export function startEngine({ onEvent, onLog, onNotify, fdLimit } = {}) {
  // fdLimit: motoru düşük dosya tanıtıcı limitiyle başlatır. GUI uygulamaları
  // launchd'den 256 devralır; testleri o koşulda çalıştırabilmek için.
  const child = fdLimit
    ? spawn('/bin/sh', ['-c', `ulimit -n ${fdLimit}; exec "$0" "$1"`, process.execPath, ENGINE], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    : spawn(process.execPath, [ENGINE], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let seq = 0;
  let buffer = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let i = buffer.indexOf('\n');
    while (i !== -1) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line) handle(JSON.parse(line));
      i = buffer.indexOf('\n');
    }
  });

  const stderr = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', d => stderr.push(d));

  function handle(msg) {
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      return;
    }
    if (msg.method === 'event') onEvent?.(msg.params);
    else if (msg.method === 'log') onLog?.(msg.params);
    onNotify?.(msg.method, msg.params ?? {});
  }

  return {
    child,
    stderr,
    // id'siz bildirim gönderir (ör. password:response).
    notify(method, params = {}) {
      child.stdin.write(JSON.stringify({ method, params }) + '\n');
    },
    call(method, params = {}) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      });
    },
    async stop() {
      try {
        await this.call('shutdown');
      } catch {
        /* zaten kapanmış olabilir */
      }
      child.kill();
    },
  };
}

// Bir koşul sağlanana kadar bekler; testlerin sabit sleep'e bağlı kalmaması için.
export async function waitFor(predicate, { timeout = 15000, interval = 50, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Zaman aşımı: ${label}`);
    await new Promise(r => setTimeout(r, interval));
  }
}

// SFTP'de OPEN, WRITE tamamlanmadan önce dosyayı boş olarak oluşturur.
// `waitFor(() => fs.existsSync(...))` bu yüzden yarış durumuna açıktır:
// yükleme "tamamlandı" sanılıp içerik henüz gelmeden okunabilir. Bu yardımcı
// hem varlığı hem beklenen içeriği birlikte bekler.
export async function waitForContent(fs, path, expected, opts = {}) {
  const check = typeof expected === 'function' ? expected : content => content === expected;
  return waitFor(() => {
    if (!fs.existsSync(path)) return false;
    try {
      return check(fs.readFileSync(path, 'utf8'));
    } catch {
      return false; // okuma sırasında dosya hâlâ yazılıyor olabilir
    }
  }, opts);
}
