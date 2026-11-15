'use client';

/** What we'll accept from the picker. Big photos are fine: they're resized before upload. */
export const MAX_PICK_BYTES = 15_000_000;
/** What actually gets uploaded per image (must stay under the server limit). */
export const MAX_UPLOAD_BYTES = 1_900_000;

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('Could not read the image.'));
    r.readAsDataURL(blob);
  });
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function hasTransparency(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const data = ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < data.length; i += 4 * 16) if (data[i] < 250) return true; // sample every 16th pixel
  return false;
}

/**
 * Makes any picked image upload-ready, like pump.fun does: scales it so its longest side is at most
 * `maxSide` (never upscales) and re-encodes it, keeping PNG when the image has transparency and
 * using a high-quality JPEG otherwise if the PNG is too big. Small images pass through untouched.
 * Animated GIFs can't be resized in the browser without losing the animation, so they pass through
 * as long as they fit.
 */
export async function prepareImage(file: File, maxSide: number): Promise<{ dataUrl: string; bytes: number; resized: boolean }> {
  if (file.size > MAX_PICK_BYTES) throw new Error(`${file.name} is ${(file.size / 1e6).toFixed(1)} MB. The limit is 15 MB.`);

  if (file.type === 'image/gif') {
    if (file.size > MAX_UPLOAD_BYTES) throw new Error(`${file.name} is a ${(file.size / 1e6).toFixed(1)} MB GIF. Animated GIFs can be up to 1.9 MB.`);
    return { dataUrl: await readAsDataUrl(file), bytes: file.size, resized: false };
  }

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= MAX_UPLOAD_BYTES) {
    bitmap.close();
    return { dataUrl: await readAsDataUrl(file), bytes: file.size, resized: false };
  }

  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  const transparent = hasTransparency(ctx, w, h);
  const candidates: Array<[string, number | undefined]> = transparent
    ? [['image/png', undefined], ['image/webp', 0.92], ['image/webp', 0.8]]
    : [['image/png', undefined], ['image/jpeg', 0.92], ['image/jpeg', 0.82]];
  for (const [type, quality] of candidates) {
    const blob = await toBlob(canvas, type, quality);
    if (blob && blob.type === type && blob.size <= MAX_UPLOAD_BYTES) return { dataUrl: await readAsDataUrl(blob), bytes: blob.size, resized: true };
  }
  throw new Error(`${file.name} is still too big after resizing. Try a smaller image.`);
}
