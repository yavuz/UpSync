# UpSync

***English** · [Türkçe](README.tr.md)*

**Save it, ship it.** A macOS menu bar app that watches the folders you point
it at and uploads each saved file to a remote server over SFTP or FTP. It is
editor-independent — Zed, VS Code, PhpStorm, `vim`, even `sed` all work,
because the watching happens at the OS level.

## Why

Zed's extension API offers no panels, no commands, and no file watchers. The
existing Zed SFTP extension works around this with a language-server trick,
but then uploads depend on which language Zed assigns to a file — save a
`.tpl` or `.sql` and nothing happens. UpSync cuts that dependency entirely.

## Architecture

    ┌─────────────────────────────┐
    │  SwiftUI menu bar (app/)    │  MenuBarExtra, activity window,
    │                             │  Keychain, folder management
    └───────────┬─────────────────┘
                │ stdin/stdout, newline-delimited JSON-RPC
    ┌───────────▼─────────────────┐
    │  Node engine (engine/)      │  chokidar, ssh2 (SFTP), ftp (FTP/FTPS),
    │  esbuild → single file      │  transfer/sync algorithm, ignore, profiles
    └─────────────────────────────┘

The engine is ported from [vscode-sftp](https://github.com/Natizyskunk/vscode-sftp)'s
transfer core: `core/fs`, `core/remote-client`, `scheduler`, `transferTask`,
`ignore`, `fileService`, and `fileHandlers/transfer`. Everything that depended
on the vscode API was replaced with equivalents under `engine/src/shims/`.

The Swift side spawns the engine as a child process and restarts it with
exponential backoff if it dies.

## Install

Requirements: Node.js 18+ (for the engine), Xcode 15+ / Swift 6 (to build).

    ./build.sh

This produces `build/UpSync.app`, which you can copy to Applications.
Prebuilt releases are on the [Releases page](https://github.com/yavuz/UpSync/releases).

The app locates Node in this order: bundled → `/opt/homebrew/bin` →
`/usr/local/bin` → `/usr/bin` → your login shell's PATH (for nvm, Herd, etc.).

## Configuration

When you add a folder, UpSync looks for a config file in this order:

1. `.zed/sftp.json`
2. `.vscode/sftp.json`
3. `sftp.json`

The format is identical to vscode-sftp, so existing config files work
unchanged. Comments and trailing commas (JSONC) are supported.

```jsonc
{
  "name": "Production",
  "host": "example.com",
  "protocol": "sftp",          // "sftp" | "ftp"
  "port": 22,
  "username": "deploy",
  "privateKeyPath": "~/.ssh/id_rsa",
  "remotePath": "/var/www/site",
  "context": "src",            // sync only this subdirectory
  "uploadOnSave": true,
  "ignore": ["**/node_modules/**", "**/.git/**", "*.log"],
  "watcher": {
    "autoUpload": true,        // equivalent to uploadOnSave
    "autoDelete": false        // delete remotely when deleted locally
  },
  "syncOption": {
    "delete": false,
    "skipCreate": false,
    "ignoreExisting": false,
    "update": false
  },
  "profiles": {
    "staging": { "host": "staging.example.com", "remotePath": "/var/www/staging" }
  }
}
```

### Ignore rules

The `ignore` list is evaluated with **gitignore semantics** (the `ignore` npm
package), not glob semantics. In practice:

- Bare names like `CLAUDE.md` match **at every directory level**.
- Patterns containing a path, like `crns/tests/**`, match **only from the
  root**.
- `**/cache/**` ignores the directory's *contents*, not the directory itself.
  The watcher opens that directory once but never descends into it — the cost
  is a single `readdir`. Add `**/cache` too if you want it pruned entirely.

`watcher.files` is not used here; the watcher always covers the whole folder
and filtering is done through `ignore`. A `watcher.ignore` field does not
exist in UpSync or in vscode-sftp — if you write one it is silently ignored,
so put those patterns in the top-level `ignore`.

### uploadOnSave vs. watcher.autoUpload

In vscode-sftp, `uploadOnSave` means an editor save while `watcher.autoUpload`
means an external file change. UpSync has a single watcher, so a folder is
watched if **either** flag is on. Existing configs that only say
`"uploadOnSave": true` work without modification.

### Passwords

Set `"password": true` and the password stays out of the config file. UpSync
asks on first connection, stores it if "Save to Keychain" is checked, and
never asks again. Clear it with **Forget Saved Password** in the menu.
Keychain entries are keyed by `user@host:port`.

Using `privateKeyPath` with a key is still the better option.

## Features

- Automatic upload on save, regardless of file type
- Manual upload / download / folder sync
- Bidirectional sync with `delete` / `skipCreate` / `ignoreExisting` / `update`
- `autoDelete`: mirror local deletions to the remote
- Multiple profiles (staging / production), selectable per folder
- SFTP and FTP/FTPS
- Passwords in Keychain via `"password": true`
- ssh-config parsing, agent auth, jump hosts — inherited from the engine, not
  separately tested in this project
- gitignore-compatible ignore patterns, `ignoreFile` support
- Activity window showing every upload, skip, and error

## Development

    cd engine && npm install && npm run build && npm test
    cd app && swift build

Tests spin up throwaway servers on localhost — `test/sftp-server.mjs` (built on
ssh2) and `ftp-srv`. No real server is ever contacted.

## Upstream bugs fixed during the port

Both of these were inherited from vscode-sftp and fixed here:

1. `sshClient.ts` — `.on('close', this.end())` registered the *return value*
   (`undefined`) as the listener instead of a function, and called `end()`
   while the connection was still being established. Node 22 rejects
   `undefined` listeners, so the connection never opens at all.
2. `transfer.ts` — sync's delete operations (`fileMissed` / `dirMissed`) were
   invoked inside `forEach` without being awaited, so `sync()` returned before
   deletions finished and deletion errors were silently swallowed.

## Verification status

**Tested end to end** (`engine/test`, 62 tests): upload-on-save over both SFTP
and FTP, manual upload/download, folder sync, the `delete` option,
`autoDelete`, ignore patterns, the `"password": true` flow and its account
identifier, and the absence of silent failure on a wrong password. The built
`.app` was also launched for real and confirmed to upload to a local test
server.

`test/ignore.test.mjs` takes a real project's 44-rule ignore list verbatim and
checks it against 42 separate paths: directory patterns (`**/node_modules/**`),
deep file patterns (`**/*.log`), relative full paths
(`includes/env.local.php`), bare names (`CLAUDE.md` — which matches at every
level under gitignore semantics), and wildcards (`docker-compose.*.yml`). The
same check runs for both upload-on-save and manual folder upload.

**Inherited, not separately tested**: ssh-config parsing, agent auth, jump
hosts (`hop`), `useTempFile`. This is working vscode-sftp code whose behavior
was not changed during the port, but it is outside this project's test
coverage.

**Not tested**: the UI itself — menu interactions, the folder picker, the
activity window, the password dialog. Verification was done headlessly with a
pre-seeded `folders.json`.

## File watching and the fd limit

On macOS, watching goes through **FSEvents** (chokidar 3 + `fsevents`). A
single stream covers the whole tree; no file descriptor is spent per directory
or per file.

This matters because:

- **chokidar 4 dropped macOS FSEvents support** and falls back to one
  `fs.watch` per path, which can require tens of thousands of descriptors in a
  single project.
- **Apps launched via `open` inherit a soft limit of 256 descriptors from
  launchd** (`launchctl limit maxfiles`). Running from a shell the limit is
  enormous, so the problem is invisible during development and only shows up
  in the packaged app.

Together they produce `EMFILE: too many open files` — and once descriptors run
out, even the SSH private key cannot be opened, so uploads fail too.

Two defenses are in place: FSEvents **and** the Swift side raising the
`RLIMIT_NOFILE` soft limit to `kern.maxfilesperproc` (61440) before spawning
the engine, which the child inherits.

Measured on a 1603-directory / 8000-file tree with the packaged `.app`:

| | before (chokidar 4) | after (FSEvents) |
|---|---|---|
| open fds | 15,000+ needed → EMFILE | **44** |
| memory (RSS) | ~212 MB | **86 MB** |

`test/fdlimit.test.mjs` guards against regression: it starts the engine with a
deliberate 256-descriptor limit and verifies uploads still work across an
800+ directory tree.

### Possible improvement

Watching could move to the Swift side using the FSEvents API directly, which
would remove the need to ship the `fsevents` native module. But FSEvents fires
when a write *starts*, so chokidar's `awaitWriteFinish` behavior — not
uploading a half-written file — would have to be reimplemented. Not done yet.

## App icon

The icon is drawn programmatically (`icon/render.swift`, CoreGraphics) rather
than shipped as a binary asset, so every size is regenerated from one source:

    ./icon/make-icns.sh

`build.sh` generates `icon/UpSync.icns` automatically if it is missing.

The artwork is deliberately **full-bleed** — no rounded rectangle is drawn.
macOS 26 places legacy `.icns` icons on its own standard tile, so drawing our
own squircle produced a doubled frame (our shape inside a grey system tile).
Supplying edge-to-edge art lets the system apply its own mask and edge
lighting. The trade-off: on macOS 15 and earlier the icon renders as a plain
square with no corner rounding. The proper fix is to add an Icon Composer
(`.icon`) asset alongside the `.icns`.

## Known limitations

- Node.js must be installed on the system; it is not currently bundled (the
  Node binary is ~110MB, which would push the `.app` to Electron size).
- The app is ad-hoc signed, not notarized. Gatekeeper may warn on first
  launch; right-click → **Open**, or run
  `xattr -dr com.apple.quarantine /Applications/UpSync.app`.
- No launch-at-login yet — add it manually under System Settings → General →
  Login Items.

## Releasing

`VERSION` is the single source of truth for the version number; `build.sh`
reads it and writes it into `Info.plist`.

    ./release.sh 0.2.0

The script runs the tests, writes and commits the version, builds the `.app`,
verifies the version inside the bundle, zips it with `ditto` (which preserves
the code signature), tags `vX.Y.Z`, pushes main and the tag, and publishes to
GitHub Releases with install notes.

It requires a clean working tree and an authenticated `gh`, and refuses to run
if the tag already exists.

## License

MIT — see [LICENSE](LICENSE).

The transfer engine is derived from
[vscode-sftp](https://github.com/Natizyskunk/vscode-sftp) (MIT, Natizyskunk;
originally by liximomo). The two bugs found during the port are listed above.
