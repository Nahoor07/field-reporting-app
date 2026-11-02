import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';
import fs from 'node:fs';
import { Transform, type Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { FaultController, PRESETS, faultConfigSchema, type FaultAction, type FaultConfig, type FaultRoute } from './faults.ts';
import { ID_PATTERN, MAX_CHUNK_BYTES, MAX_DESCRIPTION_LENGTH, MAX_IMAGES, MAX_IMAGE_BYTES, MIN_IMAGES } from './limits.ts';
import { Storage, type Report } from './storage.ts';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Marks a route as a fault-injection target. Admin routes leave it unset. */
    fault?: FaultRoute;
  }
  interface FastifyRequest {
    faultAction?: FaultAction | null;
  }
}

export interface AppOptions {
  dataDir: string;
  /** One line per request on stdout. Off in tests. */
  log?: boolean;
}

export interface App {
  app: FastifyInstance;
  storage: Storage;
  faults: FaultController;
}

interface CreateUploadBody {
  imageId: string;
  reportId: string;
  size: number;
  sha256: string;
  mimeType: string;
}

interface CommitBody {
  description: string;
  createdAt: string;
  images: { id: string; position: number }[];
}

const id = { type: 'string', pattern: ID_PATTERN } as const;

/**
 * Upload protocol (all calls idempotent):
 *   POST  /v1/uploads              declare an image, returns the server's current offset
 *   PATCH /v1/uploads/:imageId     append one chunk at Upload-Offset, returns new offset
 *   PUT   /v1/reports/:reportId    commit: report becomes visible once, atomically
 *   GET   /v1/reports              what the server actually holds
 */
export function buildApp({ dataDir, log = false }: AppOptions): App {
  const app = Fastify({ logger: false });
  const storage = new Storage(dataDir);
  const faults = new FaultController();
  const say = (request: FastifyRequest, message: string) => {
    if (log) console.log(`${stamp()} ${request.method.padEnd(6)} ${request.url}  ⚡ ${message}`);
  };

  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_CHUNK_BYTES }, (_req, body, done) =>
    done(null, body),
  );

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    const status = error.statusCode ?? 500;
    const code = error.validation ? 'validation_failed' : status >= 500 ? 'internal_error' : 'bad_request';
    reply.code(status).send({ error: code, message: error.message });
  });

  // ---- fault injection -------------------------------------------------------------------

  app.addHook('onRequest', async (request, reply) => {
    const route = request.routeOptions.config.fault;
    if (!route) return;
    const { network } = faults.get();
    if (network.latencyMs > 0) await sleep(network.latencyMs);

    const action = faults.take(route);
    request.faultAction = action;
    if (!action) return;
    switch (action.type) {
      case 'delay':
        say(request, `delay ${action.ms}ms`);
        await sleep(action.ms);
        return;
      case 'error':
        say(request, `injected ${action.status}`);
        return reply.code(action.status).send({ error: 'injected_fault', message: `Injected ${action.status}` });
      case 'hang':
        say(request, 'hanging, will never answer');
        reply.hijack();
        return;
      case 'drop':
        say(request, 'dropping connection');
        request.raw.socket.destroy();
        reply.hijack();
        return;
    }
  });

  app.addHook('preParsing', async (request, _reply, payload) => {
    if (!request.routeOptions.config.fault) return payload;
    let stream: Readable = payload;
    const { uploadBytesPerSec } = faults.get().network;
    if (uploadBytesPerSec) stream = stream.pipe(throttle(uploadBytesPerSec));
    const action = request.faultAction;
    if (action?.type === 'drop-mid-body') {
      stream = stream.pipe(
        dropAfter(action.afterBytes, () => {
          say(request, `dropping connection after ${action.afterBytes} body bytes`);
          request.raw.socket.destroy();
        }),
      );
    }
    return stream;
  });

  app.addHook('onSend', async (request, _reply, payload) => {
    if (request.faultAction?.type === 'lose-response') {
      say(request, 'handler ran, losing the response');
      request.raw.socket.destroy();
    }
    return payload;
  });

  app.addHook('onResponse', async (request, reply) => {
    if (log && request.routeOptions.config.fault) {
      console.log(`${stamp()} ${request.method.padEnd(6)} ${request.url}  → ${reply.statusCode} (${Math.round(reply.elapsedTime)}ms)`);
    }
  });

  // ---- client API ------------------------------------------------------------------------

  app.get('/health', async () => ({ ok: true }));

  app.post<{ Body: CreateUploadBody }>(
    '/v1/uploads',
    {
      config: { fault: 'create' },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['imageId', 'reportId', 'size', 'sha256', 'mimeType'],
          properties: {
            imageId: id,
            reportId: id,
            size: { type: 'integer', minimum: 1 },
            sha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
            mimeType: { const: 'image/jpeg' },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      if (body.size > MAX_IMAGE_BYTES) {
        return reply.code(413).send({ error: 'image_too_large', message: `Image is ${body.size} bytes; limit is ${MAX_IMAGE_BYTES}` });
      }
      const existing = storage.getUpload(body.imageId);
      if (existing) {
        const same = existing.reportId === body.reportId && existing.size === body.size && existing.sha256 === body.sha256.toLowerCase();
        if (!same) return reply.code(409).send({ error: 'upload_conflict', message: 'Image id already used with different content' });
        return { offset: existing.complete ? existing.size : existing.received, complete: existing.complete };
      }
      storage.createUpload({ ...body, sha256: body.sha256.toLowerCase() });
      return reply.code(201).send({ offset: 0, complete: false });
    },
  );

  app.patch<{ Params: { imageId: string }; Body: Buffer }>(
    '/v1/uploads/:imageId',
    { config: { fault: 'chunk' }, bodyLimit: MAX_CHUNK_BYTES },
    async (request, reply) => {
      const offset = Number(request.headers['upload-offset']);
      if (!Number.isInteger(offset) || offset < 0) {
        return reply.code(400).send({ error: 'bad_offset', message: 'Upload-Offset header must be a non-negative integer' });
      }
      const chunk = request.body;
      if (!Buffer.isBuffer(chunk) || chunk.length === 0) {
        return reply.code(400).send({ error: 'empty_chunk', message: 'Send the chunk as application/octet-stream' });
      }
      const upload = storage.getUpload(request.params.imageId);
      if (!upload) return reply.code(404).send({ error: 'upload_not_found', message: 'Declare the upload first' });
      if (upload.complete) return { offset: upload.size, complete: true };
      if (offset !== upload.received) {
        // Usually a retry of a chunk whose response was lost: tell the client where we really are.
        return reply.code(409).send({ error: 'offset_mismatch', message: 'Offset does not match', offset: upload.received });
      }
      if (offset + chunk.length > upload.size) {
        return reply.code(400).send({ error: 'chunk_overflow', message: 'Chunk runs past the declared size' });
      }
      const updated = storage.writeChunk(upload, offset, chunk);
      if (updated.received < updated.size) return { offset: updated.received, complete: false };

      if (storage.finalize(updated) === 'checksum_mismatch') {
        return reply.code(422).send({ error: 'checksum_mismatch', message: 'Assembled file does not match sha256; upload reset', offset: 0 });
      }
      return { offset: updated.size, complete: true };
    },
  );

  app.put<{ Params: { reportId: string }; Body: CommitBody }>(
    '/v1/reports/:reportId',
    {
      config: { fault: 'commit' },
      schema: {
        params: { type: 'object', properties: { reportId: id } },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['description', 'createdAt', 'images'],
          properties: {
            description: { type: 'string', minLength: 1, maxLength: MAX_DESCRIPTION_LENGTH },
            createdAt: { type: 'string', format: 'date-time' },
            images: {
              type: 'array',
              minItems: MIN_IMAGES,
              maxItems: MAX_IMAGES,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'position'],
                properties: { id, position: { type: 'integer', minimum: 0, maximum: MAX_IMAGES - 1 } },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { reportId } = request.params;
      const body = request.body;
      const description = body.description.trim();
      if (!description) return reply.code(400).send({ error: 'blank_description', message: 'Description is required' });
      const ids = new Set(body.images.map(image => image.id));
      const positions = new Set(body.images.map(image => image.position));
      if (ids.size !== body.images.length || positions.size !== body.images.length) {
        return reply.code(400).send({ error: 'duplicate_images', message: 'Image ids and positions must be unique' });
      }

      const existing = storage.getReport(reportId);
      if (existing) {
        const sameImages = existing.images.length === ids.size && existing.images.every(image => ids.has(image.id));
        if (!sameImages) return reply.code(409).send({ error: 'report_conflict', message: 'Report id already used with different images' });
        return { report: present(existing, request), created: false };
      }

      const missing = body.images
        .map(image => image.id)
        .filter(imageId => {
          const upload = storage.getUpload(imageId);
          return !upload || !upload.complete || upload.reportId !== reportId;
        });
      if (missing.length > 0) {
        return reply.code(409).send({ error: 'images_incomplete', message: 'Some images are not fully uploaded', missing });
      }

      const report = storage.insertReport({ id: reportId, description, createdAt: body.createdAt, images: body.images });
      return reply.code(201).send({ report: present(report, request), created: true });
    },
  );

  app.get('/v1/reports', { config: { fault: 'list' } }, async request => ({
    reports: storage.listReports().map(report => present(report, request)),
  }));

  app.get<{ Params: { imageId: string } }>(
    '/v1/images/:imageId',
    { config: { fault: 'image' }, schema: { params: { type: 'object', properties: { imageId: id } } } },
    async (request, reply) => {
      const file = storage.imagePath(request.params.imageId);
      if (!fs.existsSync(file)) return reply.code(404).send({ error: 'not_found', message: 'No such image' });
      return reply.type('image/jpeg').header('cache-control', 'public, max-age=31536000, immutable').send(fs.createReadStream(file));
    },
  );

  // ---- admin (never faulted) ---------------------------------------------------------------

  app.get('/__faults', async () => ({
    config: faults.get(),
    presets: Object.fromEntries(Object.entries(PRESETS).map(([name, preset]) => [name, preset.description])),
  }));

  app.put<{ Body: FaultConfig }>('/__faults', { schema: { body: faultConfigSchema } }, async request => {
    const current = faults.get();
    faults.set({ network: request.body.network ?? current.network, rules: request.body.rules ?? current.rules });
    return { config: faults.get() };
  });

  app.post<{ Params: { name: string } }>('/__faults/preset/:name', async (request, reply) => {
    const preset = PRESETS[request.params.name];
    if (!preset) return reply.code(404).send({ error: 'unknown_preset', message: `Try one of: ${Object.keys(PRESETS).join(', ')}` });
    faults.set(preset.config);
    if (log) console.log(`${stamp()} faults → ${request.params.name}: ${preset.description}`);
    return { config: faults.get() };
  });

  app.delete('/__faults', async () => {
    faults.clear();
    return { config: faults.get() };
  });

  app.get('/__stats', async () => storage.counts());

  app.post('/__reset', async () => {
    storage.wipe();
    faults.clear();
    if (log) console.log(`${stamp()} server wiped`);
    return { ok: true };
  });

  app.addHook('onClose', async () => storage.close());

  return { app, storage, faults };
}

function present(report: Report, request: FastifyRequest) {
  const base = `${request.protocol}://${request.host}`;
  return {
    ...report,
    images: report.images.map(image => ({ id: image.id, position: image.position, size: image.size, url: `${base}/v1/images/${image.id}` })),
  };
}

/** Passes bytes through at roughly `bytesPerSec`, so TCP backpressure slows the sender. */
function throttle(bytesPerSec: number): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      setTimeout(() => callback(null, chunk), (chunk.length / bytesPerSec) * 1000);
    },
  });
}

function dropAfter(limit: number, onLimit: () => void): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > limit) {
        onLimit();
        callback(new Error('connection dropped by fault injection'));
        return;
      }
      callback(null, chunk);
    },
  });
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}
