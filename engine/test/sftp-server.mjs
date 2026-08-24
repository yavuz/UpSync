// Tek kullanımlık, yalnızca localhost'a bağlanan test SFTP sunucusu.
// Uçtan uca testler bunun üzerinde koşar; gerçek bir sunucuya hiçbir zaman
// dokunulmaz.
import ssh2 from 'ssh2';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const { Server, utils } = ssh2;
const { STATUS_CODE } = utils.sftp;

export async function startSftpServer({ root, username = 'test', password = 'test' }) {
  await fsp.mkdir(root, { recursive: true });

  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });

  const resolve = p => {
    // Sunucu kökü dışına çıkışı engelle.
    const abs = path.resolve(root, '.' + path.posix.resolve('/', p));
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw Object.assign(new Error('outside root'), { code: 'EACCES' });
    }
    return abs;
  };

  const server = new Server({ hostKeys: [privateKey] }, client => {
    client
      .on('authentication', ctx => {
        if (ctx.method === 'password' && ctx.username === username && ctx.password === password) {
          ctx.accept();
        } else if (ctx.method === 'none') {
          ctx.reject(['password']);
        } else {
          ctx.reject();
        }
      })
      .on('ready', () => {
        client.on('session', accept => {
          const session = accept();
          session.on('sftp', accept2 => bindSftp(accept2(), resolve));
        });
      });
  });

  await new Promise(res => server.listen(0, '127.0.0.1', res));
  const { port } = server.address();

  return {
    port,
    username,
    password,
    root,
    close: () => new Promise(res => server.close(res)),
  };
}

function bindSftp(sftp, resolve) {
  // Ölçüm için: hangi protokol çağrısı kaç kez geldi.
  globalThis.__sftpOps = globalThis.__sftpOps || {};
  const _on = sftp.on.bind(sftp);
  sftp.on = (event, handler) => _on(event, (...args) => {
    globalThis.__sftpOps[event] = (globalThis.__sftpOps[event] || 0) + 1;
    return handler(...args);
  });

  const handles = new Map();
  let seq = 0;
  const newHandle = payload => {
    const id = seq++;
    handles.set(id, payload);
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(id, 0);
    return buf;
  };
  const getHandle = buf => handles.get(buf.readUInt32BE(0));

  const errno = err => {
    switch (err?.code) {
      case 'ENOENT':
        return STATUS_CODE.NO_SUCH_FILE;
      case 'EACCES':
      case 'EPERM':
        return STATUS_CODE.PERMISSION_DENIED;
      case 'EEXIST':
        return STATUS_CODE.FAILURE;
      default:
        return STATUS_CODE.FAILURE;
    }
  };

  const attrsOf = stat => ({
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
    size: stat.size,
    atime: Math.floor(stat.atimeMs / 1000),
    mtime: Math.floor(stat.mtimeMs / 1000),
  });

  // Performans ölçümü için yapay gidiş-dönüş gecikmesi. Gerçek bir sunucuda
  // her protokol çağrısı bir RTT demek; localhost'ta bu maliyet görünmez.
  const rtt = Number(process.env.UPSYNC_TEST_RTT || 0);

  const guard = async (reqid, fn) => {
    try {
      if (rtt > 0) {
        await new Promise(r => setTimeout(r, rtt));
      }
      await fn();
    } catch (err) {
      sftp.status(reqid, errno(err));
    }
  };

  sftp.on('REALPATH', (reqid, p) => {
    const normalized = path.posix.resolve('/', p === '.' ? '/' : p);
    sftp.name(reqid, [{ filename: normalized, longname: normalized, attrs: {} }]);
  });

  sftp.on('STAT', (reqid, p) =>
    guard(reqid, async () => sftp.attrs(reqid, attrsOf(await fsp.stat(resolve(p)))))
  );

  sftp.on('LSTAT', (reqid, p) =>
    guard(reqid, async () => sftp.attrs(reqid, attrsOf(await fsp.lstat(resolve(p)))))
  );

  sftp.on('FSTAT', (reqid, h) =>
    guard(reqid, async () => {
      const entry = getHandle(h);
      sftp.attrs(reqid, attrsOf(await fsp.stat(entry.path)));
    })
  );

  sftp.on('OPEN', (reqid, filename, flags, attrs) =>
    guard(reqid, async () => {
      const abs = resolve(filename);
      const mode = utils.sftp.flagsToString(flags) ?? 'r';
      const fd = await fsp.open(abs, mode, attrs?.mode ?? 0o644);
      sftp.handle(reqid, newHandle({ fd, path: abs }));
    })
  );

  sftp.on('READ', (reqid, h, offset, length) =>
    guard(reqid, async () => {
      const entry = getHandle(h);
      const buf = Buffer.alloc(length);
      const { bytesRead } = await entry.fd.read(buf, 0, length, offset);
      if (bytesRead === 0) {
        sftp.status(reqid, STATUS_CODE.EOF);
      } else {
        sftp.data(reqid, buf.subarray(0, bytesRead));
      }
    })
  );

  sftp.on('WRITE', (reqid, h, offset, data) =>
    guard(reqid, async () => {
      const entry = getHandle(h);
      // Test amaçlı: belirli bir dosyaya yapılan WRITE'a hiç yanıt
      // vermeden asılı kalır - bağlantının sessizce öldüğü senaryoyu
      // taklit eder (ne 'error' ne 'finish', hiçbir şey).
      const stallFile = process.env.UPSYNC_TEST_STALL_FILE;
      if (stallFile && entry.path.endsWith(stallFile)) {
        return; // reqid'e asla yanıt verilmiyor
      }
      await entry.fd.write(data, 0, data.length, offset);
      sftp.status(reqid, STATUS_CODE.OK);
    })
  );

  sftp.on('CLOSE', (reqid, h) =>
    guard(reqid, async () => {
      const entry = getHandle(h);
      if (entry?.fd) {
        await entry.fd.close();
      }
      handles.delete(h.readUInt32BE(0));
      sftp.status(reqid, STATUS_CODE.OK);
    })
  );

  sftp.on('OPENDIR', (reqid, p) =>
    guard(reqid, async () => {
      const abs = resolve(p);
      const entries = await fsp.readdir(abs, { withFileTypes: true });
      sftp.handle(reqid, newHandle({ dir: entries, path: abs, sent: false }));
    })
  );

  sftp.on('READDIR', (reqid, h) =>
    guard(reqid, async () => {
      const entry = getHandle(h);
      if (entry.sent) {
        sftp.status(reqid, STATUS_CODE.EOF);
        return;
      }
      entry.sent = true;
      const names = [];
      for (const d of entry.dir) {
        const stat = await fsp.lstat(path.join(entry.path, d.name));
        names.push({ filename: d.name, longname: d.name, attrs: attrsOf(stat) });
      }
      sftp.name(reqid, names);
    })
  );

  sftp.on('MKDIR', (reqid, p) =>
    guard(reqid, async () => {
      await fsp.mkdir(resolve(p), { recursive: true });
      sftp.status(reqid, STATUS_CODE.OK);
    })
  );

  sftp.on('RMDIR', (reqid, p) =>
    guard(reqid, async () => {
      await fsp.rm(resolve(p), { recursive: true, force: true });
      sftp.status(reqid, STATUS_CODE.OK);
    })
  );

  sftp.on('REMOVE', (reqid, p) =>
    guard(reqid, async () => {
      await fsp.unlink(resolve(p));
      sftp.status(reqid, STATUS_CODE.OK);
    })
  );

  sftp.on('RENAME', (reqid, from, to) =>
    guard(reqid, async () => {
      await fsp.rename(resolve(from), resolve(to));
      sftp.status(reqid, STATUS_CODE.OK);
    })
  );

  sftp.on('SETSTAT', (reqid, p, attrs) =>
    guard(reqid, async () => {
      const abs = resolve(p);
      if (attrs.mode !== undefined) await fsp.chmod(abs, attrs.mode);
      if (attrs.atime !== undefined && attrs.mtime !== undefined) {
        await fsp.utimes(abs, attrs.atime, attrs.mtime);
      }
      sftp.status(reqid, STATUS_CODE.OK);
    })
  );

  sftp.on('FSETSTAT', (reqid, h, attrs) =>
    guard(reqid, async () => {
      const entry = getHandle(h);
      if (attrs.mode !== undefined) await fsp.chmod(entry.path, attrs.mode);
      if (attrs.atime !== undefined && attrs.mtime !== undefined) {
        await fsp.utimes(entry.path, attrs.atime, attrs.mtime);
      }
      sftp.status(reqid, STATUS_CODE.OK);
    })
  );

  sftp.on('READLINK', (reqid, p) =>
    guard(reqid, async () => {
      const target = await fsp.readlink(resolve(p));
      sftp.name(reqid, [{ filename: target, longname: target, attrs: {} }]);
    })
  );

  sftp.on('SYMLINK', (reqid, target, linkpath) =>
    guard(reqid, async () => {
      await fsp.symlink(target, resolve(linkpath));
      sftp.status(reqid, STATUS_CODE.OK);
    })
  );
}
