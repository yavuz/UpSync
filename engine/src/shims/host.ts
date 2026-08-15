// vscode host API'lerinin motor karşılıkları.

type PasswordResolver = (prompt: string, account?: string) => Promise<string | undefined>;

let passwordResolver: PasswordResolver = async prompt => {
  throw new Error(
    `A password is required but no UI is available to ask for it: ${prompt}. ` +
      'Save the password to the Keychain, or use privateKeyPath.'
  );
};

// Swift tarafı bunu RPC üzerinden Keychain/parola diyaloğuna bağlar.
export function setPasswordResolver(resolver: PasswordResolver) {
  passwordResolver = resolver;
}

export function promptForPassword(
  prompt: string,
  account?: string
): Promise<string | undefined> {
  return passwordResolver(prompt, account);
}

// Motorun editör buffer'ı yok; dosya diskten okunur.
export function getOpenTextDocuments(): any[] {
  return [];
}

// vscode'un "remote" ayar sözlüğü yok. config.remote kullanılırsa
// fileService anlamlı bir hata versin diye boş bir map dönüyoruz.
export function getUserSetting(_section: string) {
  return {
    get<T>(_key: string): T | undefined {
      return undefined;
    },
  };
}
