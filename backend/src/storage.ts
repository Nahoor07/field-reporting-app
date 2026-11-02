import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface Upload {
  imageId: string;
  reportId: string;
  size: number;
  sha256: string;
  mimeType: string;
  received: number;
  complete: boolean;
}

export interface ReportImage {
  id: string;
  position: number;
  size: number;
  sha256: string;
}

export interface Report {
  id: string;
  description: string;
  createdAt: string;
  receivedAt: string;
  images: ReportImage[];
}

export interface NewUpload {
  imageId: string;
  reportId: string;
  size: number;
  sha256: string;
  mimeType: string;
}

export interface NewReport {
  id: string;
  description: string;
  createdAt: string;
  images: { id: string; position: number }[];
}

type Row = Record<string, unknown>;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS uploads (
    image_id   TEXT PRIMARY KEY,
    report_id  TEXT NOT NULL,
    size       INTEGER NOT NULL,
    sha256     TEXT NOT NULL,
    mime_type  TEXT NOT NULL,
    received   INTEGER NOT NULL DEFAULT 0,
    complete   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reports (
    id          TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    received_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS report_images (
    report_id TEXT NOT NULL REFERENCES reports(id),
    image_id  TEXT NOT NULL UNIQUE REFERENCES uploads(image_id),
    position  INTEGER NOT NULL,
    PRIMARY KEY (report_id, position)
  );
`;

/**
 * SQLite is the source of truth for upload offsets; files on disk are written positionally,
 * so a crash between "bytes written" and "offset recorded" just means those bytes get
 * overwritten by the client's retry. Handlers use synchronous IO on purpose: Node runs
 * them to completion one at a time, so two retries of the same chunk can never interleave.
 */
export class Storage {
  private readonly db: DatabaseSync;
  private readonly partsDir: string;
  private readonly imagesDir: string;

  constructor(private readonly dataDir: string) {
    this.partsDir = path.join(dataDir, 'parts');
    this.imagesDir = path.join(dataDir, 'images');
    fs.mkdirSync(this.partsDir, { recursive: true });
    fs.mkdirSync(this.imagesDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'reports.sqlite'));
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  getUpload(imageId: string): Upload | undefined {
    const row = this.db.prepare('SELECT * FROM uploads WHERE image_id = ?').get(imageId) as Row | undefined;
    return row ? toUpload(row) : undefined;
  }

  createUpload(input: NewUpload): Upload {
    this.db
      .prepare(
        `INSERT INTO uploads (image_id, report_id, size, sha256, mime_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.imageId, input.reportId, input.size, input.sha256, input.mimeType, new Date().toISOString());
    return { ...input, received: 0, complete: false };
  }

  /** Writes `chunk` at `offset` and records the new offset. Caller has validated offset === received. */
  writeChunk(upload: Upload, offset: number, chunk: Buffer): Upload {
    const file = this.partPath(upload.imageId);
    const fd = fs.openSync(file, fs.existsSync(file) ? 'r+' : 'w');
    try {
      fs.writeSync(fd, chunk, 0, chunk.length, offset);
      fs.ftruncateSync(fd, offset + chunk.length);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const received = offset + chunk.length;
    this.db.prepare('UPDATE uploads SET received = ? WHERE image_id = ?').run(received, upload.imageId);
    return { ...upload, received };
  }

  /** Verifies the assembled file against the declared hash and promotes it. */
  finalize(upload: Upload): 'complete' | 'checksum_mismatch' {
    const part = this.partPath(upload.imageId);
    const digest = crypto.createHash('sha256').update(fs.readFileSync(part)).digest('hex');
    if (digest !== upload.sha256.toLowerCase()) {
      fs.rmSync(part, { force: true });
      this.db.prepare('UPDATE uploads SET received = 0 WHERE image_id = ?').run(upload.imageId);
      return 'checksum_mismatch';
    }
    fs.renameSync(part, this.imagePath(upload.imageId));
    this.db.prepare('UPDATE uploads SET complete = 1 WHERE image_id = ?').run(upload.imageId);
    return 'complete';
  }

  getReport(id: string): Report | undefined {
    const row = this.db.prepare('SELECT * FROM reports WHERE id = ?').get(id) as Row | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  listReports(): Report[] {
    const rows = this.db.prepare('SELECT * FROM reports ORDER BY received_at DESC').all() as Row[];
    return rows.map(row => this.hydrate(row));
  }

  /** Inserts the report and links its images in one transaction: it becomes visible whole or not at all. */
  insertReport(input: NewReport): Report {
    const receivedAt = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare('INSERT INTO reports (id, description, created_at, received_at) VALUES (?, ?, ?, ?)')
        .run(input.id, input.description, input.createdAt, receivedAt);
      const link = this.db.prepare('INSERT INTO report_images (report_id, image_id, position) VALUES (?, ?, ?)');
      for (const image of input.images) link.run(input.id, image.id, image.position);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getReport(input.id)!;
  }

  imagePath(imageId: string): string {
    return path.join(this.imagesDir, `${imageId}.jpg`);
  }

  counts(): { reports: number; images: number; pendingUploads: number } {
    const one = (sql: string) => Number((this.db.prepare(sql).get() as Row).n);
    return {
      reports: one('SELECT COUNT(*) AS n FROM reports'),
      images: one('SELECT COUNT(*) AS n FROM report_images'),
      pendingUploads: one('SELECT COUNT(*) AS n FROM uploads WHERE image_id NOT IN (SELECT image_id FROM report_images)'),
    };
  }

  /** Test/admin only: drop every report, upload and file. */
  wipe(): void {
    this.db.exec('DELETE FROM report_images; DELETE FROM reports; DELETE FROM uploads;');
    for (const dir of [this.partsDir, this.imagesDir]) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  close(): void {
    this.db.close();
  }

  private partPath(imageId: string): string {
    return path.join(this.partsDir, `${imageId}.part`);
  }

  private hydrate(row: Row): Report {
    const images = this.db
      .prepare(
        `SELECT u.image_id, ri.position, u.size, u.sha256
         FROM report_images ri JOIN uploads u ON u.image_id = ri.image_id
         WHERE ri.report_id = ? ORDER BY ri.position`,
      )
      .all(String(row.id)) as Row[];
    return {
      id: String(row.id),
      description: String(row.description),
      createdAt: String(row.created_at),
      receivedAt: String(row.received_at),
      images: images.map(image => ({
        id: String(image.image_id),
        position: Number(image.position),
        size: Number(image.size),
        sha256: String(image.sha256),
      })),
    };
  }
}

function toUpload(row: Row): Upload {
  return {
    imageId: String(row.image_id),
    reportId: String(row.report_id),
    size: Number(row.size),
    sha256: String(row.sha256),
    mimeType: String(row.mime_type),
    received: Number(row.received),
    complete: Number(row.complete) === 1,
  };
}
