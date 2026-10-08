// Decodes BLP textures to web images, picking the first mip level that fits
// the size cap. Fully opaque textures become JPEG; anything with alpha is PNG.

import { Blp, BLP_IMAGE_FORMAT } from '@wowserhq/format';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

const JPEG_QUALITY = 85;

export function chooseMipLevel(width, height, mipLevelCount, maxSize) {
  let level = 0;
  while (level < mipLevelCount - 1 && Math.max(width >> level, height >> level) > maxSize) level += 1;
  return level;
}

export function hasTransparency(rgba) {
  for (let index = 3; index < rgba.length; index += 4) {
    if (rgba[index] < 255) return true;
  }
  return false;
}

export function encodeTexture(blpBuffer, maxSize) {
  const blp = new Blp().load(new Uint8Array(blpBuffer.buffer, blpBuffer.byteOffset, blpBuffer.byteLength));
  const level = chooseMipLevel(blp.width, blp.height, blp.mipLevelCount, maxSize);
  const image = blp.getImage(level, BLP_IMAGE_FORMAT.IMAGE_ABGR8888);
  const rgba = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  const transparent = blp.alphaSize > 0 && hasTransparency(rgba);
  if (transparent) {
    return {
      mimeType: 'image/png',
      data: PNG.sync.write({ width: image.width, height: image.height, data: rgba }),
      transparent,
    };
  }
  return {
    mimeType: 'image/jpeg',
    data: jpeg.encode({ width: image.width, height: image.height, data: rgba }, JPEG_QUALITY).data,
    transparent,
  };
}
