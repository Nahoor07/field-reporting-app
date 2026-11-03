import ImageResizer from '@bam.tech/react-native-image-resizer';
import * as RNFS from '@dr.pogodin/react-native-fs';
import { join } from '../platform/disk';
import { prepareImage, type PrepareDeps } from './prepare';

export interface ProcessedImage {
  id: string;
  /** Absolute path inside the draft directory. */
  path: string;
  size: number;
  sha256: string;
  width: number;
  height: number;
}

const stripScheme = (path: string) => path.replace(/^file:\/\//, '');

/**
 * Resize/compress natively, hash natively. Nothing here moves image bytes through JS,
 * which is what keeps an 18 MB original from freezing the UI.
 */
export async function processPhoto(sourceUri: string, imageId: string, destDir: string): Promise<ProcessedImage> {
  const workDir = join(RNFS.CachesDirectoryPath, 'resize');
  await RNFS.mkdir(workDir);

  const deps: PrepareDeps = {
    async encode(source, rung) {
      const out = await ImageResizer.createResizedImage(
        source,
        rung.maxEdge,
        rung.maxEdge,
        'JPEG',
        rung.quality,
        0,
        workDir,
        false, // strip EXIF: no GPS/device data leaves the phone; orientation is baked into the pixels
        { mode: 'contain', onlyScaleDown: true },
      );
      // Trust the file system, not the library's report, for the number the ceiling depends on.
      const { size } = await RNFS.stat(out.path);
      return { path: out.path, size, width: out.width, height: out.height };
    },
    async remove(path) {
      if (await RNFS.exists(path)) await RNFS.unlink(path);
    },
  };

  const best = await prepareImage(sourceUri, deps);
  const path = join(destDir, `${imageId}.jpg`);
  await RNFS.moveFile(stripScheme(best.path), path);
  const sha256 = await RNFS.hash(path, 'sha256');
  return { id: imageId, path, size: best.size, sha256, width: best.width, height: best.height };
}

/** The picker copies every selection into the cache dir. Once processed, the copy is dead weight. */
export async function removeSource(uri: string): Promise<void> {
  const path = stripScheme(uri);
  if (path.startsWith(RNFS.CachesDirectoryPath) && (await RNFS.exists(path))) await RNFS.unlink(path);
}

/** Everything the picker and resizer leave in the cache. Used by reset. */
export async function clearImageCaches(): Promise<void> {
  const entries = await RNFS.readDir(RNFS.CachesDirectoryPath);
  for (const entry of entries) {
    if (entry.name === 'resize' || entry.name.startsWith('rn_image_picker_lib_temp_')) {
      await RNFS.unlink(entry.path).catch(() => {});
    }
  }
}
