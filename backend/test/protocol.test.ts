import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp, type App } from '../src/app.ts';
import { MAX_IMAGE_BYTES } from '../src/limits.ts';

const sha = (buffer: Buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

let ctx: App;
let dataDir: string;

before(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'field-reports-'));
  ctx = buildApp({ dataDir });
});
after(async () => {
  await ctx.app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => {
  ctx.storage.wipe();
  ctx.faults.clear();
});

function declare(imageId: string, reportId: string, file: Buffer) {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/uploads',
    payload: { imageId, reportId, size: file.length, sha256: sha(file), mimeType: 'image/jpeg' },
  });
}

function chunk(imageId: string, offset: number, bytes: Buffer) {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/v1/uploads/${imageId}`,
    headers: { 'content-type': 'application/octet-stream', 'upload-offset': String(offset) },
    payload: bytes,
  });
}

function commit(reportId: string, imageIds: string[], description = 'Cracked beam, level 3') {
  return ctx.app.inject({
    method: 'PUT',
    url: `/v1/reports/${reportId}`,
    payload: { description, createdAt: new Date().toISOString(), images: imageIds.map((id, position) => ({ id, position })) },
  });
}

async function uploadWhole(imageId: string, reportId: string, file: Buffer) {
  await declare(imageId, reportId, file);
  return chunk(imageId, 0, file);
}

describe('chunked upload', () => {
  it('assembles chunks and reports progress', async () => {
    const file = crypto.randomBytes(10_000);
    assert.equal((await declare('image-0001', 'report-0001', file)).statusCode, 201);
    const first = await chunk('image-0001', 0, file.subarray(0, 4_000));
    assert.deepEqual(first.json(), { offset: 4_000, complete: false });
    const second = await chunk('image-0001', 4_000, file.subarray(4_000));
    assert.deepEqual(second.json(), { offset: 10_000, complete: true });
    assert.deepEqual(fs.readFileSync(ctx.storage.imagePath('image-0001')), file);
  });

  it('re-declaring returns the resume offset', async () => {
    const file = crypto.randomBytes(10_000);
    await declare('image-0001', 'report-0001', file);
    await chunk('image-0001', 0, file.subarray(0, 3_000));
    const again = await declare('image-0001', 'report-0001', file);
    assert.equal(again.statusCode, 200);
    assert.deepEqual(again.json(), { offset: 3_000, complete: false });
  });

  it('a replayed chunk (lost response) gets 409 with the true offset', async () => {
    const file = crypto.randomBytes(10_000);
    await declare('image-0001', 'report-0001', file);
    await chunk('image-0001', 0, file.subarray(0, 3_000));
    const replay = await chunk('image-0001', 0, file.subarray(0, 3_000));
    assert.equal(replay.statusCode, 409);
    assert.equal(replay.json().offset, 3_000);
  });

  it('refuses anything over the 5 MB ceiling', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/uploads',
      payload: { imageId: 'image-0001', reportId: 'report-0001', size: MAX_IMAGE_BYTES + 1, sha256: 'a'.repeat(64), mimeType: 'image/jpeg' },
    });
    assert.equal(response.statusCode, 413);
  });

  it('rejects a corrupted file and resets the upload', async () => {
    const file = crypto.randomBytes(5_000);
    await declare('image-0001', 'report-0001', file);
    const corrupted = Buffer.from(file);
    corrupted[10] = corrupted[10]! ^ 0xff;
    const response = await chunk('image-0001', 0, corrupted);
    assert.equal(response.statusCode, 422);
    assert.deepEqual((await declare('image-0001', 'report-0001', file)).json(), { offset: 0, complete: false });
  });

  it('refuses reusing an image id for different content', async () => {
    await declare('image-0001', 'report-0001', crypto.randomBytes(100));
    const response = await declare('image-0001', 'report-0001', crypto.randomBytes(100));
    assert.equal(response.statusCode, 409);
  });
});

describe('report commit', () => {
  it('creates once; a repeated commit is a no-op success', async () => {
    await uploadWhole('image-0001', 'report-0001', crypto.randomBytes(1_000));
    await uploadWhole('image-0002', 'report-0001', crypto.randomBytes(1_000));
    const first = await commit('report-0001', ['image-0001', 'image-0002']);
    assert.equal(first.statusCode, 201);
    const second = await commit('report-0001', ['image-0001', 'image-0002']);
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().created, false);
    assert.deepEqual(ctx.storage.counts(), { reports: 1, images: 2, pendingUploads: 0 });
  });

  it('lists the missing images when uploads are incomplete', async () => {
    const file = crypto.randomBytes(1_000);
    await uploadWhole('image-0001', 'report-0001', file);
    await declare('image-0002', 'report-0001', file);
    const response = await commit('report-0001', ['image-0001', 'image-0002']);
    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.json().missing, ['image-0002']);
    assert.equal(ctx.storage.counts().reports, 0);
  });

  it('validates description and image count', async () => {
    assert.equal((await commit('report-0001', ['image-0001'], '   ')).statusCode, 400);
    assert.equal((await commit('report-0001', [])).statusCode, 400);
    const six = Array.from({ length: 6 }, (_, i) => `image-000${i}`);
    assert.equal((await commit('report-0001', six)).statusCode, 400);
  });

  it('lists committed reports with image urls', async () => {
    await uploadWhole('image-0001', 'report-0001', crypto.randomBytes(1_000));
    await commit('report-0001', ['image-0001']);
    const { reports } = (await ctx.app.inject({ method: 'GET', url: '/v1/reports' })).json();
    assert.equal(reports.length, 1);
    assert.match(reports[0].images[0].url, /\/v1\/images\/image-0001$/);
  });
});

describe('injected faults', () => {
  it('error rules fire the configured number of times', async () => {
    ctx.faults.set({ network: { latencyMs: 0, uploadBytesPerSec: null }, rules: [{ route: 'list', action: { type: 'error', status: 503 }, times: 2 }] });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await ctx.app.inject({ method: 'GET', url: '/v1/reports' })).statusCode);
    assert.deepEqual(statuses, [503, 503, 200]);
  });
});
