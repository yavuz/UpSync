import * as path from 'path';
import { FileService, ServiceConfig, TransferDirection, TransferTask } from './core';
import { findConfigPath, readConfigs, validateConfig, ConfigError } from './config';
import { FolderWatcher, ChangeKind } from './watcher';
import * as ops from './operations';
import logger from './shims/logger';

// vscode-sftp'nin serviceManager.getBasePath'i ile aynı davranış.
export function getBasePath(context: string | undefined, workspace: string): string {
  if (!context) {
    return path.normalize(workspace);
  }
  return path.normalize(
    path.isAbsolute(context) ? context : path.join(workspace, context)
  );
}

export type FolderEvent =
  | { type: 'transfer'; phase: 'start'; folderId: string; localPath: string; kind: string }
  | { type: 'transfer'; phase: 'done'; folderId: string; localPath: string; kind: string; ms: number }
  | { type: 'transfer'; phase: 'error'; folderId: string; localPath: string; kind: string; message: string }
  | { type: 'skipped'; folderId: string; localPath: string; reason: string }
  | { type: 'config'; folderId: string; ok: boolean; message?: string }
  | { type: 'watcher'; folderId: string; state: 'ready' | 'stopped' | 'error'; message?: string };

export interface FolderInit {
  id: string;
  workspace: string;
  configPath?: string;
  profile?: string | null;
  enabled?: boolean;
}

export class Folder {
  readonly id: string;
  readonly workspace: string;

  private configPath: string | null = null;
  private service: FileService | null = null;
  private baseDir: string;
  private rawConfig: any = null;
  private profile: string | null;
  private watcher: FolderWatcher | null = null;
  private enabled: boolean;
  private lastError: string | null = null;

  // Aynı dosya için üst üste gelen olayları teke indirir.
  private inFlight = new Map<string, Promise<void>>();
  private queuedAgain = new Set<string>();
  // Görev başlangıç zamanları, süre ölçümü için.
  private transferStarted = new Map<TransferTask, number>();

  constructor(init: FolderInit, private readonly emit: (e: FolderEvent) => void) {
    this.id = init.id;
    this.workspace = path.normalize(init.workspace);
    this.configPath = init.configPath ?? null;
    this.profile = init.profile ?? null;
    this.enabled = init.enabled ?? true;
    this.baseDir = this.workspace;
  }

  get status() {
    return {
      id: this.id,
      workspace: this.workspace,
      configPath: this.configPath,
      profile: this.profile,
      enabled: this.enabled,
      watching: this.watcher?.running ?? false,
      error: this.lastError,
      name: this.rawConfig?.name ?? null,
      host: this.rawConfig?.host ?? null,
      protocol: this.rawConfig?.protocol ?? null,
      profiles: this.service?.getAvailableProfiles() ?? [],
      autoUpload: this.rawConfig ? isAutoUpload(this.rawConfig) : false,
      autoDelete: this.rawConfig ? isAutoDelete(this.rawConfig) : false,
    };
  }

  async load() {
    await this.stopWatching();
    this.lastError = null;

    const configPath = this.configPath ?? findConfigPath(this.workspace);
    if (!configPath) {
      this.lastError = `No config found: ${this.workspace} contains no .zed/sftp.json, .vscode/sftp.json or sftp.json.`;
      this.emit({ type: 'config', folderId: this.id, ok: false, message: this.lastError });
      return;
    }
    this.configPath = configPath;

    try {
      // Çoklu config dizisinde ilki kullanılır; ek sunucular profiles ile tanımlanır.
      const configs = readConfigs(configPath);
      if (!configs.length) {
        throw new ConfigError('The config file defines no server.', configPath);
      }
      const raw = configs[0];

      this.rawConfig = raw;
      this.baseDir = getBasePath(raw.context, this.workspace);
      this.service = new FileService(this.baseDir, this.workspace, raw);
      this.service.name = raw.name;
      this.service.setConfigValidator(validateConfig);

      // Dosya başına transfer olayları buradan gelir. Scheduler bu kancaları
      // izleyici kaynaklı yüklemeler için de manuel upload/download/sync için
      // de tetikler; tek kaynak burası olsun ki manuel bir klasör senkronu
      // sessiz kalmasın.
      this.service.beforeTransfer(task => {
        try {
        this.transferStarted.set(task as TransferTask, Date.now());
        this.emit({
          type: 'transfer',
          phase: 'start',
          folderId: this.id,
          localPath: (task as TransferTask).localFsPath,
          kind: directionToKind((task as TransferTask).transferType),
        });
        } catch (error) {
          logger.warn('beforeTransfer raporlaması başarısız', error);
        }
      });

      this.service.afterTransfer((error, task) => {
        try {
        const t = task as TransferTask;
        const startedAt = this.transferStarted.get(t) ?? Date.now();
        this.transferStarted.delete(t);
        const kind = directionToKind(t.transferType);

        if (error) {
          logger.error(`${kind} failed for ${t.localFsPath}`, error);
          this.emit({
            type: 'transfer',
            phase: 'error',
            folderId: this.id,
            localPath: t.localFsPath,
            kind,
            message: (error as Error).message ?? String(error),
          });
        } else {
          this.emit({
            type: 'transfer',
            phase: 'done',
            folderId: this.id,
            localPath: t.localFsPath,
            kind,
            ms: Date.now() - startedAt,
          });
        }
        } catch (reportError) {
          logger.warn('afterTransfer raporlaması başarısız', reportError);
        }
      });

      if (this.profile === null && raw.defaultProfile) {
        this.profile = raw.defaultProfile;
      }

      // Profil hataları dahil, config'i şimdi çözerek erken hata verelim.
      this.resolveConfig();

      this.emit({ type: 'config', folderId: this.id, ok: true });
    } catch (error) {
      this.service = null;
      this.lastError = (error as Error).message;
      this.emit({ type: 'config', folderId: this.id, ok: false, message: this.lastError });
      return;
    }

    if (this.enabled) {
      await this.startWatching();
    }
  }

  // Profil her zaman açıkça geçirilir; global state kullanılmaz, böylece
  // farklı klasörler farklı profillerde olabilir.
  private resolveConfig(): ServiceConfig {
    if (!this.service) {
      throw new Error(this.lastError ?? 'Config not loaded.');
    }
    return this.service.getConfig(this.profile ?? undefined);
  }

  private ctx() {
    return {
      fileService: this.service!,
      config: this.resolveConfig(),
      baseDir: this.baseDir,
    };
  }

  async setProfile(profile: string | null) {
    this.profile = profile;
    await this.load();
  }

  async setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (enabled) {
      if (this.service) {
        await this.startWatching();
      } else {
        await this.load();
      }
    } else {
      await this.stopWatching();
    }
  }

  async startWatching() {
    if (!this.service || !this.rawConfig) {
      return;
    }
    if (!isAutoUpload(this.rawConfig)) {
      // uploadOnSave da watcher.autoUpload da kapalıysa izleme yok;
      // klasör yalnızca manuel işlemler için duruyor.
      return;
    }

    let config: ServiceConfig;
    try {
      config = this.resolveConfig();
    } catch (error) {
      this.lastError = (error as Error).message;
      this.emit({ type: 'watcher', folderId: this.id, state: 'error', message: this.lastError });
      return;
    }

    const ignore = config.ignore;
    this.watcher = new FolderWatcher(
      this.baseDir,
      { ignored: p => (ignore ? ignore(p) : false) },
      {
        onChange: (kind, fsPath) => this.handleChange(kind, fsPath),
        onError: err =>
          this.emit({ type: 'watcher', folderId: this.id, state: 'error', message: err.message }),
        onReady: () => this.emit({ type: 'watcher', folderId: this.id, state: 'ready' }),
      }
    );
    this.watcher.start();
  }

  async stopWatching() {
    if (this.watcher) {
      await this.watcher.stop();
      this.watcher = null;
      this.emit({ type: 'watcher', folderId: this.id, state: 'stopped' });
    }
  }

  private handleChange(kind: ChangeKind, fsPath: string) {
    const isDelete = kind === 'unlink' || kind === 'unlinkDir';

    if (isDelete) {
      if (!isAutoDelete(this.rawConfig)) {
        this.emit({
          type: 'skipped',
          folderId: this.id,
          localPath: fsPath,
          reason: 'autoDelete is off',
        });
        return;
      }
      this.enqueue(fsPath, 'delete', () => ops.removeRemote(this.ctx(), fsPath).then(() => undefined));
      return;
    }

    this.enqueue(fsPath, 'upload', () => ops.upload(this.ctx(), fsPath));
  }

  // Aynı yol için işlem sürerken gelen yeni olay, bitişte tek bir tekrar
  // çalıştırmaya dönüşür. Böylece hızlı ardışık kaydetmeler kuyruğu şişirmez.
  private enqueue(fsPath: string, kind: string, run: () => Promise<unknown>) {
    if (this.inFlight.has(fsPath)) {
      this.queuedAgain.add(fsPath);
      return;
    }

    const started = Date.now();
    // Silme işlemi scheduler'dan geçmez (TransferTask üretmez), o yüzden
    // olayını burada yayıyoruz. Yüklemelerin olayları beforeTransfer /
    // afterTransfer kancalarından gelir; burada tekrar yaymıyoruz.
    const emitsOwnEvents = kind === 'delete';

    if (emitsOwnEvents) {
      this.emit({ type: 'transfer', phase: 'start', folderId: this.id, localPath: fsPath, kind });
    }

    const task = (async () => {
      try {
        await run();
        if (emitsOwnEvents) {
          this.emit({
            type: 'transfer',
            phase: 'done',
            folderId: this.id,
            localPath: fsPath,
            kind,
            ms: Date.now() - started,
          });
        }
      } catch (error) {
        const message = (error as Error).message ?? String(error);
        logger.error(`${kind} failed for ${fsPath}`, error);
        this.emit({
          type: 'transfer',
          phase: 'error',
          folderId: this.id,
          localPath: fsPath,
          kind,
          message,
        });
      } finally {
        this.inFlight.delete(fsPath);
        if (this.queuedAgain.delete(fsPath)) {
          this.enqueue(fsPath, kind, run);
        }
      }
    })();

    this.inFlight.set(fsPath, task);
  }

  upload(localPath: string) {
    return ops.upload(this.ctx(), localPath);
  }

  download(localPath: string) {
    return ops.download(this.ctx(), localPath);
  }

  sync(localPath: string, direction: ops.SyncDirection, overrides?: any) {
    return ops.syncFiles(this.ctx(), localPath, direction, overrides);
  }

  removeRemote(localPath: string) {
    return ops.removeRemote(this.ctx(), localPath);
  }

  isTransferring() {
    return this.service?.isTransferring() ?? false;
  }

  cancel() {
    this.service?.cancelTransferTasks();
  }

  async dispose() {
    await this.stopWatching();
    this.cancel();
    this.service?.dispose();
    this.service = null;
  }
}

// vscode-sftp'de uploadOnSave editör kaydını, watcher.autoUpload dışarıdan gelen
// değişikliği ifade eder. Motorun tek bir izleyicisi var, bu yüzden ikisinden
// biri açıksa izliyoruz - böylece sadece "uploadOnSave: true" yazan mevcut
// config'ler ek ayar gerektirmeden çalışır.
function isAutoUpload(config: any): boolean {
  return config?.uploadOnSave === true || config?.watcher?.autoUpload === true;
}

function isAutoDelete(config: any): boolean {
  return config?.watcher?.autoDelete === true;
}

// Scheduler yön bilgisi taşır; arayüz 'upload' / 'download' bekliyor.
function directionToKind(direction: TransferDirection): string {
  return direction === TransferDirection.REMOTE_TO_LOCAL ? 'download' : 'upload';
}
