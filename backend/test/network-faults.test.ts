import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp, type App } from '../src/app.ts';
import type { FaultRule } from '../src/faults.ts';

// These need a real socket: inject() can't drop a connection.
let ctx: App;
let base: string;
let dataDir: string;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'field-reports-net-'));
  ctx = buildApp({ dataDir });
  await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  const address = ctx.app.server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
after(async () => {
  await ctx.app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => {
  ctx.storage.wipe();
  ctx.faults.clear();
});

const rules = (...list: FaultRule[]) => ctx.faults.set({ network: { latencyMs: 0, uploadBytesPerSec: null }, rules: list });

async function declare(file: Buffer) {
  await fetch(`${base}/v1/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      imageId: 'image-0001',
      reportId: 'report-0001',
      size: file.length,
      sha256: crypto.createHash('sha256').update(file).digest('hex'),
      mimeType: 'image/jpeg',
    }),
  });
}

const sendChunk = (bytes: Buffer, offset = 0, signal?: AbortSignal) =>
  fetch(`${base}/v1/uploads/image-0001`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/octet-stream', 'upload-offset': String(offset) },
    body: new Uint8Array(bytes),
    signal,
  });

describe('network-level faults', () => {
  it('drop-mid-body kills the connection and stores nothing', async () => {
    const file = crypto.randomBytes(200_000);
    await declare(file);
    rules({ route: 'chunk', action: { type: 'drop-mid-body', afterBytes: 1_000 }, times: 1 });
    await assert.rejects(sendChunk(file));
    assert.equal(ctx.storage.getUpload('image-0001')?.received, 0);
  });

  it('lose-response stores the chunk but the client never hears back', async () => {
    const file = crypto.randomBytes(10_000);
    await declare(file);
    rules({ route: 'chunk', action: { type: 'lose-response' }, times: 1 });
    await assert.rejects(sendChunk(file.subarray(0, 4_000)));
    assert.equal(ctx.storage.getUpload('image-0001')?.received, 4_000);
    const retry = await sendChunk(file.subarray(0, 4_000));
    assert.equal(retry.status, 409);
    assert.equal((await retry.json()).offset, 4_000);
  });

  it('hang never answers; the client has to give up', async () => {
    const file = crypto.randomBytes(1_000);
    await declare(file);
    rules({ route: 'chunk', action: { type: 'hang' }, times: 1 });
    await assert.rejects(sendChunk(file, 0, AbortSignal.timeout(300)), { name: 'TimeoutError' });
    assert.equal(ctx.storage.getUpload('image-0001')?.received, 0);
  });
});
