import { Readable, Writable } from 'stream';
import FileSystem, {
  FileEntry,
  FileType,
  FileStats,
  FileOption,
} from './fileSystem';
import RemoteFileSystem from './remoteFileSystem';
import { SSHClient } from '../remote-client';

type FileHandle = Buffer;

interface SFTPFileDescriptor {
  handle: FileHandle;
  path: string;
}

interface WriteStream extends Writable {
  handle: Buffer;
  path: string;
  flags: string;
  mode: number;
  destroy(): void;
  close(): void;
}

function toSimpleFileMode(mode: number) {
  return mode & parseInt('777', 8); // tslint:disable-line:no-bitwise
}

// Bağlantı sessizce ölürse (laptop uykuya girip çıkması, wifi değişimi,
// yarı-açık TCP) ssh2'nin promise tabanlı akışları ne 'error' ne 'finish'
// üretmeden sonsuza kadar asılı kalabiliyor. KeepAliveRemoteFs'in
// onDisconnected kancası hiç tetiklenmediği için bağlantı "geçerli"
// sanılmaya devam ediyor ve sonraki her transfer aynı ölü bağlantıyı
// bekleyerek sıraya giriyor - kullanıcı tarafında "hiçbir şey olmuyor,
// tekrar deneyemiyorum" olarak görünüyor.
//
// Bu yüzden hiçbir veri/onay akışı olmadan geçen süreyi izliyoruz.
//
// Upstream hatası (bir önceki sürüm): eşik 20 saniyeydi - localhost'taki
// test sunucusuna göre ayarlanmıştı. Gerçek bir sunucuda, özellikle bir
// "task" birçok dosyayı birden değiştirdiğinde, dosya başına gerçek uçtan
// uca süre (kuyrukta bekleme + sunucunun gerçekten işlemesi) bunu rahatça
// aşabiliyordu - bağlantı ölü olmadığı halde dosya "başarısız" sayılıp
// otomatik olarak bir daha denenmiyordu. Eşik artık çok daha cömert: küçük
// kaynak dosyaları için makul her senaryoda gereğinden kısa kalmaması,
// yalnızca gerçekten ölü bir bağlantıda anlamlı olması hedefleniyor.
const STALL_TIMEOUT_MS = Number(process.env.UPSYNC_STALL_TIMEOUT_MS) || 90000;

// Bir transfer sessiz kalınca bağlantının GERÇEKTEN ölü mü yoksa sadece
// meşgul mü (ör. bir "task" birçok dosyayı birden değiştirdiğinde, o
// dosyanın sırası diğerlerinden sonra geldiği için) olduğunu ayırt etmek
// için ucuz bir REALPATH isteğiyle yokluyoruz. Bu yoklamanın kendi zaman
// aşımı - bağlantı gerçekten öldüyse bu da yanıtsız kalır.
const PROBE_TIMEOUT_MS = 5000;

export default class SFTPFileSystem extends RemoteFileSystem {
  // Bağlantı üzerindeki HERHANGİ bir transferin en son ilerleme kaydettiği
  // an. Tek bir SFTPFileSystem = tek bir canlı bağlantı; concurrency > 1
  // olduğunda birden fazla dosya bu bağlantıyı paylaşıyor.
  //
  // Upstream hatası: ilk sürümde her _put/get çağrısı kendi izole
  // zamanlayıcısına bakıyordu. concurrency:4 gibi bir ayarla 4 dosya aynı
  // bağlantıdan giderken biri - bağlantı canlı olsa bile, sadece diğer
  // üçünün arkasında sırada beklediği için - eşik kadar "sessiz" kalırsa
  // this.end() çağrılıyor ve o an giden diğer 3 dosya da dahil bağlantının
  // tamamı koparılıyordu. Artık zamanlayıcı bu paylaşılan damgaya bakıyor:
  // başka bir dosya yakın zamanda ilerlemişse bağlantı meşgul ama sağlıklı
  // sayılıyor, yalnızca TÜM transferler birlikte sessiz kalırsa asılı
  // kaldığı kabul ediliyor.
  private _lastConnectionActivity = Date.now();

  // `markProgress` her veri/onay olayında çağrılır ve paylaşılan damgayı
  // günceller. Bağlantı genelinde eşik aşılırsa `onStall` bir kere çağrılır.
  private _stallGuard(onStall: () => void): { markProgress: () => void; clear: () => void } {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cleared = false;

    // Yeni bir transferin BAŞLAMASI da bir etkinliktir. Bunu işaretlemezsek
    // `_lastConnectionActivity` bağlantı kurulduğu andan (ya da önceki
    // transferin bittiği andan, bir süre boşta kaldıktan sonra) kalma
    // olabilir - o zaman yeni transferin ilk baytı gelmeden guard anında
    // "eski" sayıp sahte stall bildirebilir.
    this._lastConnectionActivity = Date.now();

    const schedule = () => {
      if (timer) clearTimeout(timer);
      const idleFor = Date.now() - this._lastConnectionActivity;
      const remaining = STALL_TIMEOUT_MS - idleFor;
      if (remaining <= 0) {
        onStall();
        return;
      }
      // Bağlantı genelinde henüz eşik dolmadı; kalan süre kadar bekleyip
      // paylaşılan damgayı tekrar kontrol et - bu arada başka bir dosya
      // ilerleme kaydetmiş olabilir.
      timer = setTimeout(schedule, remaining);
    };
    schedule();

    return {
      markProgress: () => {
        this._lastConnectionActivity = Date.now();
        if (!cleared) {
          schedule();
        }
      },
      clear: () => {
        cleared = true;
        if (timer) clearTimeout(timer);
        timer = null;
      },
    };
  }

  // Aynı anda birden fazla transfer sessiz kalırsa hepsi bunu çağırabilir;
  // tek bir yoklama yeter, aynı anda birden fazla REALPATH göndermeye gerek
  // yok - bekleyenler aynı sonucu paylaşır.
  private _probePromise: Promise<boolean> | null = null;

  idleFor(): number {
    return Date.now() - this._lastConnectionActivity;
  }

  // Ucuz bir REALPATH ile bağlantının canlı olup olmadığını sorar. Yanıtın
  // içeriği önemli değil - hata bile dönse protokolün canlı olduğunu
  // gösterir. Yanıt hiç gelmezse bağlantı ölüdür.
  probeAlive(timeoutMs: number = PROBE_TIMEOUT_MS): Promise<boolean> {
    if (this._probePromise) {
      return this._probePromise;
    }

    this._probePromise = new Promise<boolean>(resolve => {
      let settled = false;
      const done = (alive: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._probePromise = null;
        if (alive) {
          // Bağlantı canlı: başka bekleyen transferlerin de az önce
          // yaşanan tek dosyalık aksaklık yüzünden gereksiz yere
          // başarısız sayılmaması için paylaşılan damgayı tazele.
          this._lastConnectionActivity = Date.now();
        }
        resolve(alive);
      };
      const timer = setTimeout(() => done(false), timeoutMs);

      try {
        const sftp = this.sftp;
        if (!sftp) {
          done(false);
          return;
        }
        sftp.realpath('.', () => done(true));
      } catch {
        // sftp nesnesine erişilemiyor - bağlantı zaten kullanılamaz durumda.
        done(false);
      }
    });

    return this._probePromise;
  }

  // Bir transfer sessiz kaldığında ÇAĞRILAN taraf (kendi promise'ini
  // reddeden kod) zaten başarısız sayıldı. Burada asıl karar veriliyor:
  // bağlantının TAMAMI kapatılsın mı, yoksa bu sadece o dosyaya özgü/geçici
  // bir yavaşlık mıydı?
  //
  // Upstream hatası (bir önceki sürüm): stall algılanır algılanmaz
  // bağlantı hiç sorgulanmadan `this.end()` ile kapatılıyordu. Bir "task"
  // birçok dosyayı birden değiştirdiğinde, diğer dosyalar hızlıca bitip
  // bağlantı gerçekten boşta kaldıktan SONRA sırası gelen tek bir yavaş
  // dosya bile - bağlantı tamamen sağlıklı olsa dahi - bu şekilde
  // kapatılıyordu; o an başka hiçbir transfer olmadığı için "paylaşılan
  // etkinlik" damgası da onu kurtaramıyordu.
  //
  // Artık kapatmadan önce ucuz bir REALPATH ile yokluyoruz. Yanıt gelirse
  // (hata olsa bile - önemli olan protokolün canlı olması) bağlantıya
  // dokunulmuyor; yalnızca o anki dosya başarısız sayılıp yeniden
  // denenebilir kalıyor. Yoklama da yanıtsız kalırsa bağlantı gerçekten
  // ölü demektir ve o zaman kapatılıyor ki sonraki denemeler sıfırdan
  // bağlansın.
  private _confirmDeadThenDisconnect() {
    this.probeAlive().then(alive => {
      if (!alive) {
        this.end();
      }
    });
  }

  get sftp() {
    return this.getClient().getFsClient();
  }

  toFileStat(stat): FileStats {
    return {
      type: FileSystem.getFileTypecharacter(stat),
      mode: toSimpleFileMode(stat.mode), // tslint:disable-line:no-bitwise
      size: stat.size,
      mtime: this.toLocalTime(stat.mtime * 1000),
      atime: this.toLocalTime(stat.atime * 1000),
    };
  }

  toFileEntry(fullPath, item): FileEntry {
    return {
      fspath: fullPath,
      name: item.filename,
      ...this.toFileStat(item.attrs),
    };
  }

  _createClient(option) {
    return new SSHClient(option);
  }

  lstat(path: string): Promise<FileStats> {
    return new Promise((resolve, reject) => {
      this.sftp.lstat(path, (err, stat) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(this.toFileStat(stat));
      });
    });
  }

  open(
    path: string,
    flags: string,
    mode?: number
  ): Promise<SFTPFileDescriptor> {
    return new Promise((resolve, reject) => {
      this.sftp.open(path, flags, mode, (err, handle) => {
        if (err) {
          return reject(err);
        }

        resolve({
          path,
          handle,
        });
      });
    });
  }

  close(fd: SFTPFileDescriptor): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.close(fd.handle, err => {
        if (err) {
          reject(err);
          return;
        }

        resolve();
      });
    });
  }

  fstat(fd: SFTPFileDescriptor): Promise<FileStats> {
    return new Promise((resolve, reject) => {
      this.sftp.fstat(fd.handle, (err, stat) => {
        if (err) {
          // Try stat() for sftp servers that may not support fstat() for
          // whatever reason
          // see WriteStream.prototype.open in ssh2-streams.
          this.sftp.stat(fd.path, (_err, _stat) => {
            if (_err) {
              reject(err);
              return;
            }

            resolve(this.toFileStat(_stat));
          });
          return;
        }

        resolve(this.toFileStat(stat));
      });
    });
  }

  futimes(fd: SFTPFileDescriptor, atime: number, mtime: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.futimes(
        fd.handle,
        this.toRemoteTimeInSecnonds(atime),
        this.toRemoteTimeInSecnonds(mtime),
        err => {
          if (err) {
            reject(err);
            return;
          }

          resolve();
        }
      );
    });
  }

  /// İzin ve zaman damgasını tek FSETSTAT paketinde gönderir.
  /// Ayrı fchmod + futimes iki gidiş-dönüş demekti; uzak sunucuda
  /// dosya başına 6 protokol çağrısının 2'si buydu.
  async setAttributes(
    fd: SFTPFileDescriptor,
    attrs: { mode?: number; atime?: number; mtime?: number }
  ): Promise<void> {
    const payload: any = {};
    if (attrs.mode !== undefined) {
      payload.mode = attrs.mode;
    }
    if (attrs.atime !== undefined && attrs.mtime !== undefined) {
      payload.atime = attrs.atime;
      payload.mtime = attrs.mtime;
    }
    if (Object.keys(payload).length === 0) {
      return;
    }

    return new Promise<void>((resolve, reject) => {
      this.sftp.fsetstat(fd.handle, payload, err => {
        if (!err) {
          resolve();
          return;
        }
        // fsetstat'ı handle üzerinde desteklemeyen sunucular var;
        // fchmod'daki ile aynı geri düşüş.
        if (payload.mode === undefined) {
          reject(err);
          return;
        }
        this.sftp.chmod(fd.path, payload.mode, chmodErr => {
          if (chmodErr) {
            reject(chmodErr);
            return;
          }
          if (payload.mtime === undefined) {
            resolve();
            return;
          }
          this.sftp.utimes(fd.path, payload.atime, payload.mtime, utimesErr => {
            if (utimesErr) {
              reject(utimesErr);
              return;
            }
            resolve();
          });
        });
      });
    });
  }

  fchmod(fd: SFTPFileDescriptor, mode: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.fchmod(fd.handle, mode, err => {
        if (err) {
          // Try chmod() for sftp servers that may not support fchmod() for
          // whatever reason
          // see WriteStream.prototype.open in ssh2-streams.
          this.sftp.chmod(fd.path, mode, _err => {
            if (_err) {
              reject(err);
              return;
            }

            resolve();
          });
          return;
        }

        resolve();
      });
    });
  }

  async chmod(path: string, mode: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.chmod(path, mode, err => {
        if(err) {
          reject(err)
          return
        }
        resolve();
      });
    })
  }

  get(path, option?: FileOption): Promise<Readable> {
    return new Promise((resolve, reject) => {
      // const opt = { ...option, autoDestroy: false };
      try {
        // const stream = this.sftp.createReadStream(path, opt);
        const stream = this.sftp.createReadStream(path, option);

        // İndirme akışı da yazma akışıyla aynı riski taşıyor: bağlantı
        // sessizce ölürse ne 'data' ne 'end' ne 'error' gelmeyebilir.
        // Akış burada resolve edildikten sonra tüketimi çağıranın elinde
        // olduğu için gözcüyü akışın kendisine bağlıyoruz.
        const guard = this._stallGuard(() => {
          const err = new Error(
            `No response from server for ${STALL_TIMEOUT_MS / 1000}s while downloading ${path} - connection appears to be stuck`
          );
          stream.emit('error', err);
          (stream as any).destroy?.(err);
          this._confirmDeadThenDisconnect();
        });
        stream.on('data', guard.markProgress);
        stream.once('end', guard.clear);
        stream.once('error', guard.clear);
        stream.once('close', guard.clear);

        resolve(stream);
      } catch (err) {
        reject(err);
      }
    });
  }

  rename(srcPath: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.rename(srcPath, destPath, err => {
        if (err) {
          return reject(err);
        }

        resolve();
      });
    });
  }

  // See: https://github.com/mscdex/ssh2/issues/1054
  renameAtomic(srcPath: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.ext_openssh_rename(srcPath, destPath, err => {
        if (err) {
          return reject(err);
        }

        resolve();
      });
    });
  }

  async put(input: Readable, path, option?: FileOption): Promise<void> {
    if (option && option.fd) {
      const fd = option.fd as SFTPFileDescriptor;
      // const opt = { ...option, handle: fd.handle, autoDestroy: false };
      const opt = { ...option, handle: fd.handle };
      delete opt.fd;

      if (opt.mode) {
        // mode will get ignored if handle passed in.
        // call chmod manunally.
        try {
          await this.fchmod(fd, opt.mode);
        } catch {
          // ignore error
        }
      }

      return this._put(input, path, opt);
    }

    return this._put(input, path, option);
  }

  readlink(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.sftp.readlink(path, (err, linkString) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(linkString);
      });
    });
  }

  symlink(targetPath: string, path: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.sftp.symlink(targetPath, path, err => {
        if (err) {
          reject(err);
        }
        resolve();
      });
    });
  }

  mkdir(dir: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.sftp.mkdir(dir, err => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  async ensureDir(dir: string): Promise<void> {
    // test is root path
    // win: c:/, c://, c:\, c:\\
    // *nix: /
    if (dir === '/' || dir.match(/^[a-zA-Z]:(\/|\\)\1?$/)) {
      return;
    }

    let err;
    try {
      await this.mkdir(dir);
      return;
    } catch (error) {
      // avoid nested code block
      err = error;
    }

    switch (err.code) {
      case 2:
        const parentPath = this.pathResolver.dirname(dir);
        if (parentPath === dir) throw err;
        await this.ensureDir(parentPath);
        await this.mkdir(dir);
        break;

      // In the case of any other error, just see if there's a dir
      // there already.  If so, then hooray!  If not, then something
      // is borked.
      default:
        try {
          const stat = await this.lstat(dir);
          if (stat.type !== FileType.Directory) throw err;
        } catch {
          // if the stat fails, then that's super weird.
          // let the original error be the failure reason
          throw err;
        }
        break;
    }
  }

  list(dir: string, { showHiddenFiles = true } = {}): Promise<FileEntry[]> {
    return new Promise((resolve, reject) => {
      this.sftp.readdir(dir, (err, result) => {
        if (err) {
          reject(err);
          return;
        }

        const fileEntries = result.map(item =>
          this.toFileEntry(this.pathResolver.join(dir, item.filename), item)
        );
        resolve(fileEntries);
      });
    });
  }

  unlink(path: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.sftp.unlink(path, err => {
        if (err) {
          reject(err);
          return;
        }

        resolve();
      });
    });
  }

  rmdir(path: string, recursive: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!recursive) {
        this.sftp.rmdir(path, err => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
        return;
      }

      this.list(path).then(
        fileEntries => {
          if (!fileEntries.length) {
            this.rmdir(path, false).then(resolve, e => {
              reject(e);
            });
            return;
          }

          const rmPromises = fileEntries.map(file => {
            if (file.type === FileType.Directory) {
              return this.rmdir(file.fspath, true);
            }
            return this.unlink(file.fspath);
          });

          Promise.all(rmPromises)
            .then(() => this.rmdir(path, false))
            .then(resolve, e => {
              // BUG just reject will occur weird bug.
              reject(e);
            });
        },
        err => {
          reject(err);
        }
      );
    });
  }

  private _put(
    input: Readable,
    path,
    option?: {
      flags?: string;
      encoding?: string;
      mode?: number;
      autoClose?: boolean;
      handle?: FileHandle;
    }
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const writer: WriteStream = this.sftp.createWriteStream(path, option);

      let settled = false;
      const guard = this._stallGuard(() => {
        if (settled) return;
        settled = true;
        (writer as any).destroy?.();
        reject(
          new Error(
            `No response from server for ${STALL_TIMEOUT_MS / 1000}s while uploading ${path} - connection appears to be stuck`
          )
        );
        // Bağlantı gerçekten ölü mü yoksa sadece meşgul mü - kapatma
        // kararı yoklamadan sonra veriliyor (bkz. _confirmDeadThenDisconnect).
        this._confirmDeadThenDisconnect();
      });

      writer
        .once('error', err => {
          if (settled) return;
          settled = true;
          guard.clear();
          reject(err);
        })
        .once('finish', () => {
          if (settled) return;
          settled = true;
          guard.clear();
          resolve();
        });
      // 'drain', yazma tarafının tıkanmayıp veri kabul etmeye devam
      // ettiğini gösterir - büyük/yavaş dosyalarda sayaç bu sayede
      // ilerlerken sıfırlanır.
      writer.on('drain', guard.markProgress);

      input.once('error', err => {
        if (settled) return;
        settled = true;
        guard.clear();
        reject(err);
        writer.end();
      });
      // Küçük dosyalarda tek 'data' olayı gelir; büyüklerinde her paket
      // ilerlemeyi tazeler.
      input.on('data', guard.markProgress);
      input.pipe(writer);
    });
  }
}
