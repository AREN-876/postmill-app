import sharp from 'sharp';
import { createHash } from 'node:crypto';
import type { EditorialLiveImageAsset } from './editorial-signed-transport';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PIXELS = 1536 * 1024;

// Fully decode independently; never alter the original signed bytes.
export async function validateEditorialLiveJpeg(bytes: Buffer, asset: EditorialLiveImageAsset): Promise<void> {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4 || bytes.length > MAX_BYTES ||
      bytes.length !== asset.size_bytes || asset.mime !== 'image/jpeg' ||
      createHash('sha256').update(bytes).digest('hex') !== asset.sha256 ||
      bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length-2] !== 0xff || bytes[bytes.length-1] !== 0xd9 ||
      !((asset.provider === 'openai' && asset.model === 'gpt-image-2.6-flare' && asset.width === 1536 && asset.height === 1024) ||
        (asset.provider === 'fal' && ['fal-ai/flux-2/klein/9b','fal-ai/flux/schnell'].includes(asset.model) &&
          asset.width === 1152 && asset.height === 768))) throw new Error('editorial_jpeg_invalid');
  const options = { failOn: 'warning' as const, limitInputPixels: MAX_PIXELS, sequentialRead: true };
  const metadata = await sharp(bytes, options).metadata();
  if (metadata.format !== 'jpeg' || metadata.width !== asset.width || metadata.height !== asset.height ||
      (metadata.pages ?? 1) !== 1) throw new Error('editorial_jpeg_invalid');
  const decoded = await sharp(bytes, options).removeAlpha().toColourspace('srgb').raw().toBuffer({resolveWithObject:true});
  if (decoded.info.width !== asset.width || decoded.info.height !== asset.height ||
      decoded.info.channels !== 3 || decoded.data.length !== asset.width * asset.height * 3)
    throw new Error('editorial_jpeg_invalid');
}
