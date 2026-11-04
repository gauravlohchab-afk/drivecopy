import type { FILE_CATEGORIES } from '../models/File.js';

export type FileCategory = (typeof FILE_CATEGORIES)[number];

type Signature = 'pdf' | 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'avif' | 'heic' | 'zip' | 'ole' | 'iso-bmff' | 'ebml' | 'riff-avi' | 'riff-wav' | 'ogg' | 'mp3' | 'flac' | 'rtf' | 'text';

interface TypeRule {
  mime: string;
  category: FileCategory;
  // How the first bytes of the uploaded object are checked after upload.
  signature: Signature;
  // Safe to render inline in the browser from a presigned URL.
  inlinePreview: boolean;
}

/**
 * Upload allow-list. Anything not listed here is rejected. The MIME type stored and sent to S3
 * is always the one from this table, never the browser-supplied value.
 * Executables, scripts, HTML and SVG are intentionally excluded (active content).
 */
export const FILE_TYPES: Record<string, TypeRule> = {
  pdf: { mime: 'application/pdf', category: 'pdf', signature: 'pdf', inlinePreview: true },

  png: { mime: 'image/png', category: 'image', signature: 'png', inlinePreview: true },
  jpg: { mime: 'image/jpeg', category: 'image', signature: 'jpeg', inlinePreview: true },
  jpeg: { mime: 'image/jpeg', category: 'image', signature: 'jpeg', inlinePreview: true },
  gif: { mime: 'image/gif', category: 'image', signature: 'gif', inlinePreview: true },
  webp: { mime: 'image/webp', category: 'image', signature: 'webp', inlinePreview: true },
  bmp: { mime: 'image/bmp', category: 'image', signature: 'bmp', inlinePreview: true },
  avif: { mime: 'image/avif', category: 'image', signature: 'avif', inlinePreview: true },
  heic: { mime: 'image/heic', category: 'image', signature: 'heic', inlinePreview: false },

  mp4: { mime: 'video/mp4', category: 'video', signature: 'iso-bmff', inlinePreview: true },
  m4v: { mime: 'video/x-m4v', category: 'video', signature: 'iso-bmff', inlinePreview: true },
  mov: { mime: 'video/quicktime', category: 'video', signature: 'iso-bmff', inlinePreview: true },
  webm: { mime: 'video/webm', category: 'video', signature: 'ebml', inlinePreview: true },
  mkv: { mime: 'video/x-matroska', category: 'video', signature: 'ebml', inlinePreview: true },
  avi: { mime: 'video/x-msvideo', category: 'video', signature: 'riff-avi', inlinePreview: false },

  mp3: { mime: 'audio/mpeg', category: 'audio', signature: 'mp3', inlinePreview: true },
  m4a: { mime: 'audio/mp4', category: 'audio', signature: 'iso-bmff', inlinePreview: true },
  wav: { mime: 'audio/wav', category: 'audio', signature: 'riff-wav', inlinePreview: true },
  ogg: { mime: 'audio/ogg', category: 'audio', signature: 'ogg', inlinePreview: true },
  flac: { mime: 'audio/flac', category: 'audio', signature: 'flac', inlinePreview: true },

  doc: { mime: 'application/msword', category: 'document', signature: 'ole', inlinePreview: false },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', category: 'document', signature: 'zip', inlinePreview: false },
  odt: { mime: 'application/vnd.oasis.opendocument.text', category: 'document', signature: 'zip', inlinePreview: false },
  rtf: { mime: 'application/rtf', category: 'document', signature: 'rtf', inlinePreview: false },
  xls: { mime: 'application/vnd.ms-excel', category: 'spreadsheet', signature: 'ole', inlinePreview: false },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', category: 'spreadsheet', signature: 'zip', inlinePreview: false },
  ods: { mime: 'application/vnd.oasis.opendocument.spreadsheet', category: 'spreadsheet', signature: 'zip', inlinePreview: false },
  csv: { mime: 'text/csv', category: 'spreadsheet', signature: 'text', inlinePreview: false },
  ppt: { mime: 'application/vnd.ms-powerpoint', category: 'presentation', signature: 'ole', inlinePreview: false },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', category: 'presentation', signature: 'zip', inlinePreview: false },
  odp: { mime: 'application/vnd.oasis.opendocument.presentation', category: 'presentation', signature: 'zip', inlinePreview: false },

  txt: { mime: 'text/plain', category: 'text', signature: 'text', inlinePreview: true },
  md: { mime: 'text/markdown', category: 'text', signature: 'text', inlinePreview: true },
  json: { mime: 'application/json', category: 'text', signature: 'text', inlinePreview: false },
  log: { mime: 'text/plain', category: 'text', signature: 'text', inlinePreview: true },

  zip: { mime: 'application/zip', category: 'archive', signature: 'zip', inlinePreview: false },
};

export const ALLOWED_EXTENSIONS = Object.keys(FILE_TYPES);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

export function ruleFor(name: string): (TypeRule & { extension: string }) | null {
  const extension = extensionOf(name);
  const rule = FILE_TYPES[extension];
  return rule ? { ...rule, extension } : null;
}

export function inlinePreviewAllowed(mimeType: string): boolean {
  return Object.values(FILE_TYPES).some((r) => r.mime === mimeType && r.inlinePreview);
}

const ascii = (buf: Uint8Array, offset: number, text: string) =>
  text.split('').every((ch, i) => buf[offset + i] === ch.charCodeAt(0));
const bytes = (buf: Uint8Array, offset: number, values: number[]) =>
  values.every((v, i) => buf[offset + i] === v);

/**
 * Checks the leading bytes of an uploaded object against the signature expected for its
 * extension. This catches renamed executables and mislabeled content; it is not a malware scan.
 */
export function matchesSignature(signature: Signature, head: Uint8Array): boolean {
  switch (signature) {
    case 'pdf':
      return ascii(head, 0, '%PDF-');
    case 'png':
      return bytes(head, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'jpeg':
      return bytes(head, 0, [0xff, 0xd8, 0xff]);
    case 'gif':
      return ascii(head, 0, 'GIF87a') || ascii(head, 0, 'GIF89a');
    case 'webp':
      return ascii(head, 0, 'RIFF') && ascii(head, 8, 'WEBP');
    case 'bmp':
      return ascii(head, 0, 'BM');
    case 'avif':
    case 'heic':
    case 'iso-bmff':
      return ascii(head, 4, 'ftyp');
    case 'zip':
      return bytes(head, 0, [0x50, 0x4b, 0x03, 0x04]) || bytes(head, 0, [0x50, 0x4b, 0x05, 0x06]);
    case 'ole':
      return bytes(head, 0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    case 'ebml':
      return bytes(head, 0, [0x1a, 0x45, 0xdf, 0xa3]);
    case 'riff-avi':
      return ascii(head, 0, 'RIFF') && ascii(head, 8, 'AVI ');
    case 'riff-wav':
      return ascii(head, 0, 'RIFF') && ascii(head, 8, 'WAVE');
    case 'ogg':
      return ascii(head, 0, 'OggS');
    case 'flac':
      return ascii(head, 0, 'fLaC');
    case 'mp3':
      return ascii(head, 0, 'ID3') || (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0);
    case 'rtf':
      return ascii(head, 0, '{\\rtf');
    case 'text':
      // Plain text must not contain NUL bytes (a strong indicator of binary content).
      return !head.includes(0);
  }
}

export function signatureFor(extension: string): Signature | null {
  return FILE_TYPES[extension]?.signature ?? null;
}

/** Normalises a user-supplied display name. The result is only ever stored as metadata. */
export function sanitizeName(input: string): string {
  return input
    .normalize('NFC')
    // Control characters and path separators have no place in a display name.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f/\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 255);
}
