/**
 * A closed ImageBitmap, and one transferred to a Worker, both report zero
 * width and height. Drawing one throws an InvalidStateError, so every canvas
 * checks this before it draws.
 */
export type BitmapSize = { width: number; height: number };

export function isBitmapUsable(
  bitmap: BitmapSize | null | undefined,
): boolean {
  return (
    bitmap != null &&
    Number.isFinite(bitmap.width) &&
    Number.isFinite(bitmap.height) &&
    bitmap.width > 0 &&
    bitmap.height > 0
  );
}
