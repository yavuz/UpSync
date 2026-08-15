import * as path from 'path';
import {
  FileService,
  ServiceConfig,
  TransferDirection,
  TransferTask,
  FileSystem,
  FileType,
} from './core';
import { transfer, sync } from './fileHandlers/transfer';
import { toRemotePath } from './shims/helper';

// vscode-sftp'nin createFileHandler'ının editörsüz karşılığı:
// aynı transformOption mantığı, aynı transfer/sync çağrıları.

export interface Target {
  localFsPath: string;
  remoteFsPath: string;
}

export function resolveTarget(
  localPath: string,
  baseDir: string,
  config: ServiceConfig
): Target {
  return {
    localFsPath: path.normalize(localPath),
    remoteFsPath: toRemotePath(path.normalize(localPath), baseDir, config.remotePath),
  };
}

function uploadOption(config: ServiceConfig) {
  return {
    perserveTargetMode:
      config.protocol === 'sftp' && !config.filePerm && !config.dirPerm,
    useTempFile: config.useTempFile,
    openSsh: config.openSsh,
    ignore: config.ignore,
    filePerm: config.filePerm,
    dirPerm: config.dirPerm,
  };
}

function downloadOption(config: ServiceConfig) {
  return {
    perserveTargetMode: false,
    ignore: config.ignore,
  };
}

function syncOptionOf(config: ServiceConfig, overrides: any = {}) {
  const syncOption = (config as any).syncOption || {};
  return {
    delete: syncOption.delete,
    skipCreate: syncOption.skipCreate,
    ignoreExisting: syncOption.ignoreExisting,
    update: syncOption.update,
    ...overrides,
  };
}

interface RunContext {
  fileService: FileService;
  config: ServiceConfig;
  baseDir: string;
}

async function withScheduler(
  ctx: RunContext,
  run: (collect: (t: TransferTask) => void, fs: { local: FileSystem; remote: FileSystem }) => Promise<any>
) {
  const remoteFs = await ctx.fileService.getRemoteFileSystem(ctx.config);
  const localFs = ctx.fileService.getLocalFileSystem();
  const scheduler = ctx.fileService.createTransferScheduler(ctx.config.concurrency);
  const result = await run(t => scheduler.add(t), { local: localFs, remote: remoteFs });
  await scheduler.run();
  return result;
}

export function upload(ctx: RunContext, localPath: string) {
  const target = resolveTarget(localPath, ctx.baseDir, ctx.config);
  return withScheduler(ctx, (collect, fs) =>
    transfer(
      {
        srcFsPath: target.localFsPath,
        srcFs: fs.local,
        targetFsPath: target.remoteFsPath,
        targetFs: fs.remote,
        transferOption: uploadOption(ctx.config),
        filePerm: ctx.config.filePerm,
        dirPerm: ctx.config.dirPerm,
        transferDirection: TransferDirection.LOCAL_TO_REMOTE,
      } as any,
      collect
    )
  );
}

export function download(ctx: RunContext, localPath: string) {
  const target = resolveTarget(localPath, ctx.baseDir, ctx.config);
  return withScheduler(ctx, (collect, fs) =>
    transfer(
      {
        srcFsPath: target.remoteFsPath,
        srcFs: fs.remote,
        targetFsPath: target.localFsPath,
        targetFs: fs.local,
        transferOption: downloadOption(ctx.config),
        transferDirection: TransferDirection.REMOTE_TO_LOCAL,
      } as any,
      collect
    )
  );
}

export type SyncDirection = 'localToRemote' | 'remoteToLocal' | 'both';

export function syncFiles(
  ctx: RunContext,
  localPath: string,
  direction: SyncDirection,
  overrides: any = {}
) {
  const target = resolveTarget(localPath, ctx.baseDir, ctx.config);
  const base = syncOptionOf(ctx.config, overrides);

  return withScheduler(ctx, (collect, fs) => {
    if (direction === 'remoteToLocal') {
      return sync(
        {
          srcFsPath: target.remoteFsPath,
          srcFs: fs.remote,
          targetFsPath: target.localFsPath,
          targetFs: fs.local,
          transferOption: { ...base, perserveTargetMode: false, ignore: ctx.config.ignore },
          transferDirection: TransferDirection.REMOTE_TO_LOCAL,
        } as any,
        collect
      );
    }

    return sync(
      {
        srcFsPath: target.localFsPath,
        srcFs: fs.local,
        targetFsPath: target.remoteFsPath,
        targetFs: fs.remote,
        transferOption: {
          ...base,
          ...uploadOption(ctx.config),
          bothDiretions: direction === 'both',
        },
        transferDirection: TransferDirection.LOCAL_TO_REMOTE,
      } as any,
      collect
    );
  });
}

// autoDelete için: lokalde silinen yolun uzak karşılığını kaldırır.
export async function removeRemote(ctx: RunContext, localPath: string) {
  const target = resolveTarget(localPath, ctx.baseDir, ctx.config);
  const remoteFs = await ctx.fileService.getRemoteFileSystem(ctx.config);

  const stat = await remoteFs.lstat(target.remoteFsPath);
  if (stat.type === FileType.Directory) {
    await remoteFs.rmdir(target.remoteFsPath, true);
  } else {
    await remoteFs.unlink(target.remoteFsPath);
  }
  return target.remoteFsPath;
}
