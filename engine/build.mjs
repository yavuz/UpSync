import * as esbuild from 'esbuild';

// Not: bilerek tip kontrolü yapılmıyor. Portlanan kod 2018 dönemi TypeScript
// (joi@10, lru-cache@4, tslint idiomları) ve modern tsc'den geçmiyor.
// esbuild tipleri sadece siliyor; çalışma zamanı davranışı etkilenmiyor.
const options = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'dist/engine.js',
  sourcemap: true,
  logLevel: 'info',
  // ssh2 isteğe bağlı native hızlandırıcıyı dinamik require ediyor; yoksa
  // saf JS'e düşüyor. Bundle'a girmesin.
  external: [
    'cpu-features',
    './crypto/build/Release/sshcrypto.node',
    // fsevents native bir modül; bundle'a giremez. chokidar bunu macOS'ta
    // dinamik olarak yükler ve tek bir FSEvents akışıyla tüm ağacı izler.
    // Olmadığında dosya başına fs.watch'a düşüyor ve GUI uygulamasının
    // 256 fd limitinde EMFILE alıyoruz.
    'fsevents',
  ],
  // jsonc-parser'ın UMD girişi dinamik require kullanıyor ve bundle içinde
  // çözülemiyor; ESM buildine yönlendiriyoruz.
  alias: {
    'jsonc-parser': 'jsonc-parser/lib/esm/main.js',
  },
};

if (process.argv.includes('--watch')) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
