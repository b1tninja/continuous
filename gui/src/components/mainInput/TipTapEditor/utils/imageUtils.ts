import { IIdeMessenger } from "../../../../context/IdeMessenger";
import { IMAGE_MIME_TYPES } from "../drop/classifyDrop";
import { MAX_IMAGE_BYTES } from "../drop/resolveDrop";

/**
 * Longest side an image is scaled down to. Claude resizes anything longer
 * than 1568 px on its long edge, so a larger image only costs upload time;
 * 1024 (the old value) made text in screenshots hard to read.
 */
export const MAX_IMAGE_DIMENSION = 1568;

/**
 * Largest encoded image sent. Bedrock's Converse API refuses an image over
 * 3.75 MB; a PNG that encodes larger is sent as JPEG instead.
 */
export const MAX_ENCODED_IMAGE_BYTES = 3.75 * 1024 * 1024;

const JPEG_QUALITY = 0.85;

export type EncodedImageType = "image/png" | "image/jpeg" | "image/webp";

/**
 * The size to draw an image at: scaled down so its longest side is at most
 * `maxDimension`, never scaled up, and at least 1 px on each side.
 */
export function scaledImageSize(
  width: number,
  height: number,
  maxDimension: number = MAX_IMAGE_DIMENSION,
): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 };
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * The format to re-encode an image in. PNG and GIF stay lossless (PNG), so
 * screenshots of text stay sharp and transparency is kept; WebP stays WebP;
 * everything else becomes JPEG.
 */
export function encodedTypeFor(mime: string): EncodedImageType {
  const type = mime.toLowerCase();
  if (type === "image/png" || type === "image/gif") return "image/png";
  if (type === "image/webp") return "image/webp";
  return "image/jpeg";
}

/** Bytes a base64 data URL decodes to. */
export function dataUrlByteLength(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  const base64 = comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/** True when the file is an image type the chat can send, within the size cap. */
export function isSupportedImageFile(file: { type: string; size: number }) {
  return (
    IMAGE_MIME_TYPES.includes(file.type.toLowerCase()) &&
    file.size <= MAX_IMAGE_BYTES
  );
}

export function getDataUrlForFile(
  file: File,
  img: HTMLImageElement,
): string | undefined {
  const { width, height } = scaledImageSize(img.width, img.height);
  if (!width || !height) {
    console.error("Error getting image data url: the image has no size");
    return;
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    console.error("Error getting image data url: 2d context not found");
    return;
  }
  ctx.drawImage(img, 0, 0, width, height);

  const type = encodedTypeFor(file.type);
  const dataUrl = canvas.toDataURL(type, JPEG_QUALITY);
  if (
    type !== "image/jpeg" &&
    dataUrlByteLength(dataUrl) > MAX_ENCODED_IMAGE_BYTES
  ) {
    // Too big losslessly; a JPEG of the same pixels is far smaller.
    return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  }
  return dataUrl;
}

/** Loads an image element from a URL; undefined if the browser cannot decode it. */
function loadImage(src: string): Promise<HTMLImageElement | undefined> {
  return new Promise((resolve) => {
    const img = new window.Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(undefined);
    img.src = src;
  });
}

/**
 * Scales and re-encodes an image file for the chat input. Resolves to the
 * decoded image and its data URL, or undefined when the file is not a
 * supported image (a toast says why) or cannot be decoded.
 */
export async function handleImageFile(
  ideMessenger: IIdeMessenger,
  file: File,
): Promise<[HTMLImageElement, string] | undefined> {
  if (!isSupportedImageFile(file)) {
    ideMessenger.post("showToast", [
      "error",
      `Images must be PNG, JPEG, GIF or WebP and at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`,
    ]);
    return undefined;
  }

  const urls = window.URL || window.webkitURL;
  const objectUrl = urls.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    if (!img) return undefined;
    const dataUrl = getDataUrlForFile(file, img);
    if (!dataUrl) return undefined;
    const encoded = await loadImage(dataUrl);
    return encoded ? [encoded, dataUrl] : undefined;
  } finally {
    urls.revokeObjectURL(objectUrl);
  }
}
