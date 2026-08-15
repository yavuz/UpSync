import * as path from 'path';
import chokidar, { FSWatcher } from 'chokidar';

export type ChangeKind = 'add' | 'change' | 'unlink' | 'unlinkDir';

export interface WatcherEvents {
  onChange(kind: ChangeKind, fsPath: string): void;
  onError(error: Error): void;
  onReady(): void;
}

export interface WatcherOptions {
  // Yol ignore edilmeli mi. chokidar'a doğrudan verilir: dev4 gibi projelerde
  // node_modules/vendor dallarına hiç inilmemesi için filtrelemenin izleyici
  // seviyesinde olması şart, sonradan elemek on binlerce dosya izlemek demek.
  ignored(fsPath: string): boolean;
  followSymlinks?: boolean;
}

export class FolderWatcher {
  private watcher: FSWatcher | null = null;

  constructor(
    private readonly baseDir: string,
    private readonly options: WatcherOptions,
    private readonly events: WatcherEvents
  ) {}

  start() {
    if (this.watcher) {
      return;
    }

    this.watcher = chokidar.watch(this.baseDir, {
      ignoreInitial: true,
      followSymlinks: this.options.followSymlinks ?? false,
      ignorePermissionErrors: true,
      // Editörler atomik kaydeder (geçici dosya + rename) ama büyük dosyalar
      // parça parça yazılır. Boyut sabitlenene kadar bekliyoruz, yoksa yarım
      // dosya yüklenir.
      //
      // Eşik doğrudan "kaydet → sunucuda" gecikmesine biniyor. Ölçüm
      // (3 MB'lık dosyayı 30 ms aralıklarla yazan bir süreçle):
      //
      //   eşik    gecikme (medyan)   büyük dosya
      //   200 ms      316 ms          tam
      //   100 ms      117 ms          tam
      //    50 ms      102 ms          tam
      //   kapalı      101 ms          YARIM (3 MB'ın 1 MB'ı)
      //
      // 100 ms gecikmeyi neredeyse üçte bire indiriyor ve hâlâ yavaş yazan
      // süreçleri yakalıyor. Altına inmek kayda değer bir şey kazandırmıyor,
      // kapatmak dosyayı bozuyor.
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 25,
      },
      ignored: (fsPath: string) => {
        if (path.normalize(fsPath) === path.normalize(this.baseDir)) {
          return false;
        }
        return this.options.ignored(fsPath);
      },
    });

    this.watcher
      .on('add', p => this.events.onChange('add', p))
      .on('change', p => this.events.onChange('change', p))
      .on('unlink', p => this.events.onChange('unlink', p))
      .on('unlinkDir', p => this.events.onChange('unlinkDir', p))
      .on('error', err => this.events.onError(err as Error))
      .on('ready', () => this.events.onReady());
  }

  async stop() {
    if (!this.watcher) {
      return;
    }
    const w = this.watcher;
    this.watcher = null;
    await w.close();
  }

  get running() {
    return this.watcher !== null;
  }
}
