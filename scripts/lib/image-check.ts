/**
 * Header only image checks for downloaded OCR line images. No image library is
 * added: the bucket accepts only WebP and JPEG, so the signature, dimensions
 * and byte count are enough to reject a truncated, mislabeled or wrong file.
 * The local sha256 in the sync manifest is the stronger integrity check.
 */

export type ImageInfo = {
  format: "webp" | "jpeg";
  width: number;
  height: number;
};

const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset + length > bytes.length) return "";
  let text = "";
  for (let index = 0; index < length; index += 1) {
    text += String.fromCharCode(bytes[offset + index]);
  }
  return text;
}

function readUInt16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUInt16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUInt32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function readUInt24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function parseJpeg(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  if (
    bytes[bytes.length - 2] !== 0xff ||
    bytes[bytes.length - 1] !== 0xd9
  ) {
    return null;
  }

  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;

    let marker = bytes[offset + 1];
    offset += 2;

    // Fill bytes are allowed before a marker.
    while (marker === 0xff && offset < bytes.length) {
      marker = bytes[offset];
      offset += 1;
    }

    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;

    if (offset + 2 > bytes.length) return null;
    const length = readUInt16BE(bytes, offset);
    if (length < 2 || offset + length > bytes.length) return null;

    if (SOF_MARKERS.has(marker)) {
      if (length < 7) return null;
      const height = readUInt16BE(bytes, offset + 3);
      const width = readUInt16BE(bytes, offset + 5);
      if (width < 1 || height < 1) return null;
      return { format: "jpeg", width, height };
    }

    offset += length;
  }

  return null;
}

function parseWebp(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 20) return null;
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") {
    return null;
  }
  if (readUInt32LE(bytes, 4) + 8 !== bytes.length) return null;

  const chunk = ascii(bytes, 12, 4);
  const chunkSize = readUInt32LE(bytes, 16);
  if (chunkSize < 1 || 20 + chunkSize > bytes.length) return null;

  if (chunk === "VP8X") {
    if (chunkSize < 10) return null;
    const width = readUInt24LE(bytes, 24) + 1;
    const height = readUInt24LE(bytes, 27) + 1;
    if (width < 1 || height < 1) return null;
    return { format: "webp", width, height };
  }

  if (chunk === "VP8L") {
    if (chunkSize < 5 || bytes[20] !== 0x2f) return null;
    const bits = readUInt32LE(bytes, 21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    return { format: "webp", width, height };
  }

  if (chunk === "VP8 " || chunk === "VP8") {
    if (chunkSize < 10) return null;
    if (
      bytes[23] !== 0x9d ||
      bytes[24] !== 0x01 ||
      bytes[25] !== 0x2a
    ) {
      return null;
    }
    const width = readUInt16LE(bytes, 26) & 0x3fff;
    const height = readUInt16LE(bytes, 28) & 0x3fff;
    if (width < 1 || height < 1) return null;
    return { format: "webp", width, height };
  }

  return null;
}

export function inspectImage(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF") {
    return parseWebp(bytes);
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return parseJpeg(bytes);
  }
  return null;
}
