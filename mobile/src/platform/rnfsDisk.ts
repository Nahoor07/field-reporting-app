import * as RNFS from '@dr.pogodin/react-native-fs';
import { LocalFileError } from '../sync/errors';
import type { FileReader } from '../sync/ports';
import type { Disk } from './disk';
import { base64ToBytes } from './base64';

const stripScheme = (path: string) => path.replace(/^file:\/\//, '');

export const rnfsDisk: Disk = {
  exists: path => RNFS.exists(path),
  async mkdir(path) {
    await RNFS.mkdir(path);
  },
  readText: path => RNFS.readFile(path, 'utf8'),
  async writeTextAtomic(path, text) {
    const temp = `${path}.tmp`;
    await RNFS.writeFile(temp, text, 'utf8');
    await RNFS.moveFile(temp, path);
  },
  async move(from, to) {
    await RNFS.moveFile(from, to);
  },
  async remove(path) {
    if (await RNFS.exists(path)) await RNFS.unlink(path);
  },
  async list(path) {
    if (!(await RNFS.exists(path))) return [];
    return (await RNFS.readDir(path)).map(entry => entry.name);
  },
};

/** Byte-range reads for the upload engine. Never reads a whole photo into JS. */
export const rnfsFileReader: FileReader = {
  async read(uri, offset, length) {
    const path = stripScheme(uri);
    if (!(await RNFS.exists(path))) throw new LocalFileError(`Photo file is missing: ${path}`);
    const b64 = await RNFS.read(path, length, offset, 'base64');
    return base64ToBytes(b64);
  },
};
