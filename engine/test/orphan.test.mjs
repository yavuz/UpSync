import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { waitFor } from './client.mjs';

const ENGINE = path.resolve(fileURLToPath(new URL('../dist/engine.js', import.meta.url)));

// Uygulama çökerse motor da kapanmalı. Aksi halde arkada görünmez bir
// ikinci yükleyici kalıyor ve aynı dosyayı iki kez gönderiyor.
test('ebeveyn olunce motor da kapanir', async () => {
  // Aracı bir kabuk: motoru başlatır, sonra kendisi ölür. Böylece motorun
  // stdin'i kapanır - uygulamanın çökmesiyle aynı durum.
  const shell = spawn('/bin/sh', ['-c', `exec node ${ENGINE} & echo $!; wait`], {
    stdio: ['pipe', 'pipe', 'ignore'],
  });

  let enginePid;
  shell.stdout.setEncoding('utf8');
  shell.stdout.on('data', chunk => {
    const first = chunk.trim().split('\n')[0];
    if (!enginePid && /^\d+$/.test(first)) enginePid = Number(first);
  });

  await waitFor(() => enginePid, { label: 'motor pid', timeout: 8000 });

  const alive = pid => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  assert.ok(alive(enginePid), 'motor başlamalıydı');

  // Ebeveyni öldür; motorun stdin'i kapanır.
  shell.kill('SIGKILL');

  await waitFor(() => !alive(enginePid), {
    label: 'motor kendini kapatmalı',
    timeout: 10000,
  });
});
