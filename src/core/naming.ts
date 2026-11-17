import { createHash } from "node:crypto";

export const WINDOWS_RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"
]);

export class NamingUtils {
  /**
   * Mengubah teks menjadi slug ASCII stabil:
   * 1. Transliterasi ke ASCII (NFKD)
   * 2. Lowercase
   * 3. Ganti karakter selain [a-z0-9] dengan tanda hubung
   * 4. Potong maksimal maxLength (default 28 karakter)
   */
  public static toSlug(input: string, maxLength = 28): string {
    // Buang ekstensi jika ada
    const base = input.replace(/\.[a-zA-Z0-9]+$/, "");

    let s = base
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "") // buang aksen
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

    if (!s) s = "x";

    if (s.length > maxLength) {
      s = s.slice(0, maxLength).replace(/-+$/, "");
    }

    if (WINDOWS_RESERVED_NAMES.has(s.toUpperCase())) {
      s = `${s}-clip`;
    }

    return s;
  }

  /**
   * Menghasilkan hash 8 karakter dari kombinasi 4 elemen untuk anti-tabrakan deterministik.
   */
  public static computeHash8(
    productSlug: string,
    hookFile: string,
    bodyFile: string,
    ctaFile: string
  ): string {
    const raw = `${productSlug}|${hookFile}|${bodyFile}|${ctaFile}`;
    return createHash("sha1").update(raw).digest("hex").slice(0, 8);
  }

  /**
   * Menghasilkan nama file output final deterministik kanonik:
   * [product]__[hook]__[body]__[cta]__[hash8].mp4
   */
  public static formatOutputFilename(
    productSlug: string,
    hookSlug: string,
    bodySlug: string,
    ctaSlug: string,
    hash8: string
  ): string {
    return `${productSlug}__${hookSlug}__${bodySlug}__${ctaSlug}__${hash8}.mp4`;
  }
}
