import CustomError from '../customError';

export interface ConnectOption {
  // common
  host: string;
  port: number;
  username?: string;
  password?: string;
  connectTimeout?: number;
  debug(x: string): void;

  // ssh-only
  privateKeyPath?: string;
  privateKey?: string;
  passphrase?: string | boolean;
  interactiveAuth?: boolean | string[];
  agent?: string;
  sock?: any;
  hop?: ConnectOption | ConnectOption[];
  limitOpenFilesOnRemote?: boolean | number;

  // ftp-only
  secure?: any;
  secureOptions?: object;
  passive?: boolean;
}

export enum ErrorCode {
  CONNECT_CANCELLED,
}

export interface Config {
  askForPasswd(msg: string, account?: string): Promise<string | undefined>;
}

export default abstract class RemoteClient {
  protected _client: any;
  protected _option: ConnectOption;
  private _disconnectListeners: Array<(reason: string) => void> = [];
  private _clientEventsBound: boolean = false;

  constructor(option: ConnectOption) {
    this._option = option;
    this._client = this._initClient();
  }

  abstract end(): void;
  abstract getFsClient(): any;
  protected abstract _doConnect(connectOption: ConnectOption, config: Config): Promise<void>;
  protected abstract _hasProvideAuth(connectOption: ConnectOption): boolean;
  protected abstract _initClient(): any;

  async connect(connectOption: ConnectOption, config: Config) {
    // `"password": true` = "şifreyi bana sorma, arayüzden/Keychain'den al".
    // Bu durumda kimlik sağlanmış sayılmaz.
    const wantsPasswordPrompt = (connectOption as any).password === true;
    if (!wantsPasswordPrompt && this._hasProvideAuth(connectOption)) {
      return this._doConnect(connectOption, config);
    }

    const password = await config.askForPasswd(
      `[${connectOption.host}]: Enter your password`,
      accountId(connectOption)
    );

    // cancel connect
    if (password === undefined) {
      throw new CustomError(ErrorCode.CONNECT_CANCELLED, 'cancelled');
    }

    return this._doConnect({ ...connectOption, password }, config);
  }

  onDisconnected(cb: (reason: string) => void) {
    this._disconnectListeners.push(cb);

    if (this._clientEventsBound) {
      return;
    }
    this._clientEventsBound = true;
    this._client
      .on('end', () => {
        this._notifyDisconnected('end');
      })
      .on('close', () => {
        this._notifyDisconnected('close');
      })
      .on('error', _err => {
        this._notifyDisconnected('error');
      });
  }

  // Kopuş yalnızca soket olaylarından öğrenilemiyor: yarı-açık bir soketi
  // (uzak uç sessizce gitmiş) `end()` ile kapatmak 'close' üretmeyebilir.
  // Bu yüzden bağlantıyı bilerek kapattığımızda da haber veriyoruz -
  // havuzun ölü bir bağlantıyı "geçerli" sanmaya devam etmemesi için.
  protected _notifyDisconnected(reason: string) {
    for (const cb of this._disconnectListeners.slice()) {
      try {
        cb(reason);
      } catch {
        /* dinleyici hatası kopuş bildirimini engellemesin */
      }
    }
  }
}

// Keychain anahtarı: aynı sunucudaki farklı kullanıcılar ayrışsın.
export function accountId(option: ConnectOption): string {
  const port = (option as any).port ? `:${(option as any).port}` : '';
  return `${option.username ?? ''}@${option.host ?? ''}${port}`;
}
