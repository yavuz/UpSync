import upath from './upath';
import { promptForPassword } from '../shims/host';
import logger from '../shims/logger';
import app from '../shims/app';
import { ConnectOption } from './remote-client/remoteClient';
import {
  FileSystem,
  RemoteFileSystem,
  SFTPFileSystem,
  FTPFileSystem,
} from './fs';
import localFs from './localFs';

function hashOption(opiton) {
  return Object.keys(opiton)
    .map(key => opiton[key])
    .join('');
}

// Havuzdaki bağlantı bu süreden uzun boştaysa, kullanılmadan önce gerçekten
// canlı mı diye yoklanıyor. Boşta kalan bağlantıyı düşüren bir NAT / güvenlik
// duvarı ya da uykuya dalıp uyanan bir laptop, koparıldığına dair hiçbir olay
// üretmeden bağlantıyı öldürebiliyor; yoklama olmadan bunu ancak yanıtsız
// kalan ilk yükleme keepalive zaman aşımına düşünce - onlarca saniye sonra -
// anlıyorduk. Kullanıcı tarafında bu, "ara verip döndüm, artık yüklemiyor"
// demek. Yoklamanın maliyeti tek bir gidiş-dönüş.
const IDLE_PROBE_AFTER_MS = Number(process.env.UPSYNC_IDLE_PROBE_AFTER_MS) || 60000;

class KeepAliveRemoteFs {
  private isValid: boolean = false;

  private pendingPromise: Promise<RemoteFileSystem> | null = null;

  private fs: RemoteFileSystem | null = null;

  async getFs(
    option: ConnectOption & {
      protocol: string;
      remoteTimeOffsetInHours: number;
    }
  ): Promise<RemoteFileSystem> {
    if (this.isValid && this.fs) {
      const cached = this.fs;
      if (cached.idleFor() >= IDLE_PROBE_AFTER_MS) {
        const alive = await cached.probeAlive();
        if (!alive) {
          logger.info('Idle connection is dead, reconnecting.');
          this.invalid('idle probe failed', cached);
        }
      }

      // Yoklama sırasında bağlantı geçersiz kılınmış olabilir; hâlâ aynı
      // ve geçerliyse kullan, değilse aşağıda yenisi kurulur.
      if (this.isValid && this.fs === cached) {
        this.pendingPromise = null;
        return cached;
      }
    }

    if (this.pendingPromise) {
      return this.pendingPromise;
    }

    const connectOption = Object.assign({}, option);
    // tslint:disable variable-name
    let FsConstructor: typeof SFTPFileSystem | typeof FTPFileSystem;
    if (option.protocol === 'sftp') {
      connectOption.debug = function debug(str) {
        const log = str.match(/^DEBUG(?:\[SFTP\])?: (.*?): (.*?)$/);

        if (log) {
          if (log[1] === 'Parser') return;
          logger.debug(`${log[1]}: ${log[2]}`);
        } else {
          logger.debug(str);
        }
      };
      FsConstructor = SFTPFileSystem;
    } else if (option.protocol === 'ftp') {
      connectOption.debug = function debug(str) {
        const log = str.match(/^\[connection\] (>|<) (.*?)(\\r\\n)?$/);

        if (!log) return;

        if (log[2].match(/200 NOOP/)) return;

        if (log[2].match(/^PASS /)) log[2] = 'PASS ******';

        logger.debug(`${log[1]} ${log[2]}`);
      };
      FsConstructor = FTPFileSystem;
    } else {
      throw new Error(`unsupported protocol ${option.protocol}`);
    }

    const fs = new FsConstructor(upath, {
      clientOption: connectOption,
      remoteTimeOffsetInHours: option.remoteTimeOffsetInHours,
    });
    this.fs = fs;
    // Kopuş bildirimi, HANGİ bağlantıdan geldiğiyle birlikte taşınıyor.
    // Eskiden bildirim kimliksizdi: ölen bağlantının gecikmeli 'close'
    // olayı, o sırada kurulmakta olan YENİ bağlantıyı kapatabiliyordu -
    // ardından yeni bağlantı "geçerli" işaretlenip havuzda ölü olarak
    // kalıyor ve sonraki her yükleme sessizce asılıyordu.
    fs.onDisconnected(reason => this.invalid(reason, fs));

    app.sftpBarItem.showMsg('connecting...', connectOption.connectTimeout);
    const pendingPromise = fs
      .connect(connectOption, {
        askForPasswd: promptForPassword,
      })
      .then(
        () => {
          // Bağlanırken bu bağlantı geçersiz kılındıysa (ör. kopuş
          // bildirimi geldi) geçerli işaretlemiyoruz - yoksa havuzda ölü
          // bir bağlantı canlı sanılarak kalır.
          if (this.fs !== fs) {
            throw new Error('Connection was closed while connecting');
          }
          app.sftpBarItem.reset();
          this.isValid = true;
          return fs;
        },
        err => {
          this.invalid('error', fs);
          throw err;
        }
      );
    this.pendingPromise = pendingPromise;

    return pendingPromise;
  }

  invalid(reason: string, fs?: RemoteFileSystem) {
    const target = fs ?? this.fs;
    // Bildirim eski bir bağlantıdan geliyorsa yok say: güncel bağlantıya
    // dokunmak, yeni kurulmuş sağlam bir oturumu koparmak demek.
    if (!target || this.fs !== target) {
      return;
    }

    // Önce havuzdan düşür: `end()` yeni bir kopuş bildirimi doğuracak,
    // bu sayede o bildirim burada "eski bağlantı" olarak elenir.
    this.fs = null;
    this.isValid = false;
    this.pendingPromise = null;
    logger.debug(`connection invalidated (${reason})`);
    target.end();
  }

  end() {
    this.invalid('closed');
  }
}

function getLocalFs() {
  return Promise.resolve(localFs);
}

const fsTable: {
  [x: string]: KeepAliveRemoteFs;
} = {};

export function createRemoteIfNoneExist(option): Promise<FileSystem> {
  if (option.protocol === 'local') {
    return getLocalFs();
  }

  const identity = hashOption(option);
  const fs = fsTable[identity];
  if (fs !== undefined) {
    return fs.getFs(option);
  }

  const fsInstance = new KeepAliveRemoteFs();
  fsTable[identity] = fsInstance;
  return fsInstance.getFs(option);
}

export function removeRemoteFs(option) {
  const identity = hashOption(option);
  const fs = fsTable[identity];
  if (fs !== undefined) {
    fs.end();
    delete fsTable[identity];
  }
}
