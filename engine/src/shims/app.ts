import LRU from 'lru-cache';
import logger from './logger';

// vscode'daki global app nesnesinin motor karşılığı.
// state.profile bilinçli olarak null: profil her zaman FileService.getConfig(profile)
// çağrısına açıkça geçirilir, böylece klasörler birbirinin profilini ezmez.
interface AppState {
  profile: string | null;
}

type StatusSink = (message: string | null) => void;

let statusSink: StatusSink = message => {
  if (message) {
    logger.info(message);
  }
};

// Swift arayüzü bağlantı durumunu burdan alır.
export function setStatusSink(sink: StatusSink) {
  statusSink = sink;
}

// vscode'un durum çubuğu öğesinin yerine geçer; portlanan kod bunu
// bağlantı ilerlemesini bildirmek için çağırıyor.
const sftpBarItem = {
  showMsg(message: string, _timeoutOrDetail?: unknown, _timeout?: unknown) {
    statusSink(message);
  },
  reset() {
    statusSink(null);
  },
};

interface App {
  fsCache: LRU.Cache<string, string>;
  state: AppState;
  sftpBarItem: typeof sftpBarItem;
}

const app: App = Object.create(null);

app.state = { profile: null };
app.fsCache = LRU<string, string>({ max: 6 });
app.sftpBarItem = sftpBarItem;

export default app;
