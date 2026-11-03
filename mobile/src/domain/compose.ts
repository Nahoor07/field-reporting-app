import { MAX_DESCRIPTION_LENGTH, MAX_IMAGES, MAX_IMAGE_BYTES, MIN_IMAGES } from './limits';

export interface DraftPhoto {
  id: string;
  /** Absolute path of the processed JPEG in the draft directory. */
  path: string;
  size: number;
  sha256: string;
  width: number;
  height: number;
}

export type ComposeProblem =
  | { kind: 'no_description' }
  | { kind: 'description_too_long'; max: number }
  | { kind: 'no_photos' }
  | { kind: 'too_many_photos'; max: number }
  | { kind: 'photo_too_large'; index: number }
  | { kind: 'still_preparing'; count: number };

/** Every reason this draft can't be submitted yet, in the order a person should fix them. */
export function composeProblems(draft: {
  description: string;
  photos: DraftPhoto[];
  preparing: number;
}): ComposeProblem[] {
  const problems: ComposeProblem[] = [];
  const description = draft.description.trim();
  if (!description) problems.push({ kind: 'no_description' });
  if (description.length > MAX_DESCRIPTION_LENGTH)
    problems.push({ kind: 'description_too_long', max: MAX_DESCRIPTION_LENGTH });
  if (draft.photos.length + draft.preparing < MIN_IMAGES) problems.push({ kind: 'no_photos' });
  if (draft.photos.length > MAX_IMAGES) problems.push({ kind: 'too_many_photos', max: MAX_IMAGES });
  const oversized = draft.photos.findIndex(photo => photo.size > MAX_IMAGE_BYTES);
  if (oversized !== -1) problems.push({ kind: 'photo_too_large', index: oversized });
  if (draft.preparing > 0) problems.push({ kind: 'still_preparing', count: draft.preparing });
  return problems;
}

/** How many more photos fit. Slots being prepared count: they will become photos. */
export const remainingSlots = (photos: number, preparing: number) => Math.max(0, MAX_IMAGES - photos - preparing);
