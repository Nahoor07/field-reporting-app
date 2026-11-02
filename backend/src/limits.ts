/** Hard ceiling per image. The app must never send more; the server refuses anything over it anyway. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MIN_IMAGES = 1;
export const MAX_IMAGES = 5;
export const MAX_DESCRIPTION_LENGTH = 1000;
/** Largest single chunk the server accepts. Clients on 2G use far smaller chunks. */
export const MAX_CHUNK_BYTES = 1024 * 1024;
/** Client-generated ids (UUIDs in practice). Kept lenient so tests can use readable ids. */
export const ID_PATTERN = '^[A-Za-z0-9_-]{8,64}$';
