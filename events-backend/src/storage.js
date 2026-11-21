import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import crypto from "crypto";

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID || "", secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "" },
});
const Bucket = process.env.R2_BUCKET;

// Magic-byte check; the browser-supplied mimetype is never trusted.
export function sniffImage(buf) {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf.length > 12 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length > 12 && buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") return "webp";
  return null;
}

// Re-encodes the image (strips metadata and any embedded payload) and stores it privately in R2.
export async function putImage(buf, prefix, { maxWidth = 1600, lossless = false } = {}) {
  if (!sniffImage(buf)) throw Object.assign(new Error("Upload a JPG, PNG or WebP image."), { status: 400 });
  const img = sharp(buf).rotate().resize({ width: maxWidth, withoutEnlargement: true });
  const ext = lossless ? "png" : "webp"; // QR codes stay lossless so they remain scannable
  const out = await (lossless ? img.png() : img.webp({ quality: 85 })).toBuffer();
  const Key = `${prefix}/${crypto.randomUUID()}.${ext}`;
  await s3.send(new PutObjectCommand({ Bucket, Key, Body: out, ContentType: `image/${ext}`, CacheControl: "private, max-age=3600" }));
  return Key;
}
export async function getObject(Key) {
  return s3.send(new GetObjectCommand({ Bucket, Key }));
}
