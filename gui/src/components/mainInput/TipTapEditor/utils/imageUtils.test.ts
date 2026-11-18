import { describe, expect, it } from "vitest";
import { MAX_IMAGE_BYTES } from "../drop/resolveDrop";
import {
  dataUrlByteLength,
  encodedTypeFor,
  isSupportedImageFile,
  MAX_IMAGE_DIMENSION,
  scaledImageSize,
} from "./imageUtils";

describe("scaledImageSize", () => {
  it("leaves an image within the limit at its own size (never upscales)", () => {
    expect(scaledImageSize(100, 50)).toEqual({ width: 100, height: 50 });
    expect(scaledImageSize(MAX_IMAGE_DIMENSION, 10)).toEqual({
      width: MAX_IMAGE_DIMENSION,
      height: 10,
    });
  });

  it("scales the longest side down to the limit, keeping the aspect ratio", () => {
    expect(scaledImageSize(3136, 1568)).toEqual({
      width: MAX_IMAGE_DIMENSION,
      height: 784,
    });
    expect(scaledImageSize(1000, 4000, 1000)).toEqual({
      width: 250,
      height: 1000,
    });
  });

  it("keeps at least one pixel on a very thin image", () => {
    expect(scaledImageSize(100_000, 2, 1000)).toEqual({
      width: 1000,
      height: 1,
    });
  });

  it("returns zero for an image with no size", () => {
    expect(scaledImageSize(0, 100)).toEqual({ width: 0, height: 0 });
    expect(scaledImageSize(100, 0)).toEqual({ width: 0, height: 0 });
    expect(scaledImageSize(Number.NaN, 100)).toEqual({ width: 0, height: 0 });
    expect(scaledImageSize(-5, 100)).toEqual({ width: 0, height: 0 });
  });
});

describe("encodedTypeFor", () => {
  it("keeps PNG lossless and turns GIF into PNG", () => {
    expect(encodedTypeFor("image/png")).toBe("image/png");
    expect(encodedTypeFor("image/gif")).toBe("image/png");
  });

  it("keeps WebP", () => {
    expect(encodedTypeFor("image/webp")).toBe("image/webp");
  });

  it("uses JPEG for JPEG and anything else", () => {
    expect(encodedTypeFor("image/jpeg")).toBe("image/jpeg");
    expect(encodedTypeFor("image/jpg")).toBe("image/jpeg");
    expect(encodedTypeFor("")).toBe("image/jpeg");
  });

  it("ignores case", () => {
    expect(encodedTypeFor("IMAGE/PNG")).toBe("image/png");
  });
});

describe("dataUrlByteLength", () => {
  it("counts decoded bytes, allowing for padding", () => {
    // "abc" -> YWJj (no padding), "ab" -> YWI= (1), "a" -> YQ== (2)
    expect(dataUrlByteLength("data:image/png;base64,YWJj")).toBe(3);
    expect(dataUrlByteLength("data:image/png;base64,YWI=")).toBe(2);
    expect(dataUrlByteLength("data:image/png;base64,YQ==")).toBe(1);
  });

  it("handles an empty payload and a bare base64 string", () => {
    expect(dataUrlByteLength("data:image/png;base64,")).toBe(0);
    expect(dataUrlByteLength("YWJj")).toBe(3);
  });
});

describe("isSupportedImageFile", () => {
  it("accepts PNG, JPEG, GIF and WebP within the size cap", () => {
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(isSupportedImageFile({ type, size: 1000 })).toBe(true);
    }
  });

  it("accepts a file exactly at the cap and refuses one byte over", () => {
    expect(
      isSupportedImageFile({ type: "image/png", size: MAX_IMAGE_BYTES }),
    ).toBe(true);
    expect(
      isSupportedImageFile({ type: "image/png", size: MAX_IMAGE_BYTES + 1 }),
    ).toBe(false);
  });

  it("refuses SVG and non-image types", () => {
    expect(isSupportedImageFile({ type: "image/svg+xml", size: 10 })).toBe(
      false,
    );
    expect(isSupportedImageFile({ type: "text/plain", size: 10 })).toBe(false);
    expect(isSupportedImageFile({ type: "", size: 10 })).toBe(false);
  });

  it("ignores the case of the type", () => {
    expect(isSupportedImageFile({ type: "Image/PNG", size: 10 })).toBe(true);
  });
});
