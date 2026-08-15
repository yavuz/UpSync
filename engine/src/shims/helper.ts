import * as os from 'os';
import * as path from 'path';

export function replaceHomePath(pathname: string) {
  return pathname.substr(0, 2) === '~/'
    ? path.join(os.homedir(), pathname.slice(2))
    : pathname;
}

export function resolvePath(from: string, to: string) {
  return path.resolve(from, replaceHomePath(to));
}

// vscode-uri'siz sadeleştirilmiş yol eşlemesi.
// upath: uzak taraf her zaman posix ayraç kullanır.
import upath from '../core/upath';

export function toRemotePath(localPath: string, localContext: string, remoteContext: string) {
  return upath.join(remoteContext, path.relative(localContext, localPath));
}

export function toLocalPath(remotePath: string, remoteContext: string, localContext: string) {
  return path.join(localContext, upath.relative(remoteContext, remotePath));
}

export function isSubpathOf(parent: string, pathname: string) {
  const a = path.normalize(parent);
  const b = path.normalize(pathname);
  return b === a || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}
