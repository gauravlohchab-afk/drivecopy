import { ApiError } from '../api/client';
import { folderApi, uploadApi } from '../api/endpoints';
import type { UploadPolicy } from '../api/types';
import { extensionOf } from '../lib/format';

export type UploadStatus = 'queued' | 'preparing' | 'uploading' | 'verifying' | 'done' | 'error' | 'cancelled';

export interface UploadTask {
  id: string;
  name: string;
  size: number;
  parentFolderId: string | null;
  status: UploadStatus;
  /** Bytes confirmed sent by the browser (from XHR progress events, not timers). */
  loaded: number;
  error?: string;
  /** False when retrying cannot help (e.g. file type not allowed). */
  retryable: boolean;
}

interface Internal extends UploadTask {
  file: File;
  uploadId?: string;
  mode?: 'single' | 'multipart';
  partSize?: number;
  partCount?: number;
  completedParts: Map<number, string>;
  inflight: Map<number, number>;
  xhrs: Set<XMLHttpRequest>;
  controller: AbortController;
}

const MAX_CONCURRENT_FILES = 3;
const MAX_CONCURRENT_PARTS = 4;
const MAX_ATTEMPTS = 4;

class CancelledError extends Error {}
class HttpError extends Error {
  constructor(public status: number) {
    super(`Storage responded with ${status}`);
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new CancelledError());
    }, { once: true });
  });

/** PUT straight to S3 with a presigned URL. Reports real progress from the browser. */
function putToStorage(task: Internal, url: string, body: Blob, headers: Record<string, string>, onProgress: (loaded: number) => void) {
  return new Promise<string | null>((resolve, reject) => {
    if (task.controller.signal.aborted) return reject(new CancelledError());
    const xhr = new XMLHttpRequest();
    task.xhrs.add(xhr);
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      task.xhrs.delete(xhr);
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.getResponseHeader('ETag'));
      else reject(new HttpError(xhr.status));
    };
    xhr.onerror = () => {
      task.xhrs.delete(xhr);
      reject(new HttpError(0));
    };
    xhr.onabort = () => {
      task.xhrs.delete(xhr);
      reject(new CancelledError());
    };
    xhr.send(body);
  });
}

type Listener = () => void;

export class UploadManager {
  private tasks: Internal[] = [];
  private snapshot: UploadTask[] = [];
  private listeners = new Set<Listener>();
  private policy: Promise<UploadPolicy> | null = null;
  private seq = 0;

  constructor(private onUploaded: (parentFolderId: string | null) => void) {}

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = () => this.snapshot;

  private emit() {
    this.snapshot = this.tasks.map(({ id, name, size, parentFolderId, status, loaded, error, retryable }) => ({ id, name, size, parentFolderId, status, loaded, error, retryable }));
    this.listeners.forEach((l) => l());
  }

  private update(task: Internal, patch: Partial<Internal>) {
    Object.assign(task, patch);
    this.emit();
  }

  private getPolicy() {
    this.policy ??= uploadApi.policy().catch((err) => {
      this.policy = null;
      throw err;
    });
    return this.policy;
  }

  get activeCount() {
    return this.tasks.filter((t) => ['queued', 'preparing', 'uploading', 'verifying'].includes(t.status)).length;
  }

  add(files: File[], parentFolderId: string | null) {
    for (const file of files) {
      this.tasks.push({
        id: `u${++this.seq}`,
        name: file.name,
        size: file.size,
        parentFolderId,
        status: 'queued',
        loaded: 0,
        retryable: true,
        file,
        completedParts: new Map(),
        inflight: new Map(),
        xhrs: new Set(),
        controller: new AbortController(),
      });
    }
    this.emit();
    this.pump();
  }

  /** Recreates a dropped/selected folder tree (webkitRelativePath) and uploads into it. */
  async addFolder(files: File[], parentFolderId: string | null) {
    const created = new Map<string, string | null>([['', parentFolderId]]);
    const ensure = async (dir: string): Promise<string | null> => {
      if (created.has(dir)) return created.get(dir)!;
      const slash = dir.lastIndexOf('/');
      const parent = await ensure(slash === -1 ? '' : dir.slice(0, slash));
      const { folder } = await folderApi.create(dir.slice(slash + 1), parent);
      created.set(dir, folder.id);
      return folder.id;
    };
    const byDir = new Map<string, File[]>();
    for (const f of files) {
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
      const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      byDir.set(dir, [...(byDir.get(dir) ?? []), f]);
    }
    for (const dir of [...byDir.keys()].sort()) {
      const id = await ensure(dir);
      this.add(byDir.get(dir)!, id);
    }
    this.onUploaded(parentFolderId);
  }

  cancel(id: string) {
    const task = this.tasks.find((t) => t.id === id);
    if (!task || ['done', 'cancelled'].includes(task.status)) return;
    task.controller.abort();
    task.xhrs.forEach((x) => x.abort());
    const uploadId = task.uploadId;
    this.update(task, { status: 'cancelled', error: undefined });
    // The server releases reserved quota and deletes any partial object.
    if (uploadId) uploadApi.cancel(uploadId).catch(() => undefined);
    this.pump();
  }

  retry(id: string) {
    const task = this.tasks.find((t) => t.id === id);
    if (!task || (task.status !== 'error' && task.status !== 'cancelled')) return;
    if (task.status === 'cancelled') {
      task.uploadId = undefined;
      task.completedParts.clear();
    }
    task.controller = new AbortController();
    this.update(task, { status: 'queued', error: undefined, retryable: true });
    this.pump();
  }

  dismiss(id: string) {
    const task = this.tasks.find((t) => t.id === id);
    if (task && ['queued', 'preparing', 'uploading', 'verifying'].includes(task.status)) this.cancel(id);
    this.tasks = this.tasks.filter((t) => t.id !== id);
    this.emit();
  }

  clearFinished() {
    this.tasks = this.tasks.filter((t) => !['done', 'cancelled'].includes(t.status));
    this.emit();
  }

  private pump() {
    const running = this.tasks.filter((t) => ['preparing', 'uploading', 'verifying'].includes(t.status)).length;
    const next = this.tasks.filter((t) => t.status === 'queued').slice(0, Math.max(0, MAX_CONCURRENT_FILES - running));
    for (const t of next) void this.run(t);
  }

  private async run(task: Internal) {
    this.update(task, { status: 'preparing', loaded: task.mode === 'multipart' ? task.loaded : 0 });
    try {
      // Preliminary checks for fast feedback; the server enforces the real policy.
      const policy = await this.getPolicy();
      if (task.size > policy.maxFileSize) {
        return this.update(task, { status: 'error', retryable: false, error: `File is larger than the ${Math.round(policy.maxFileSize / 1024 / 1024)} MB limit` });
      }
      if (!policy.allowedExtensions.includes(extensionOf(task.name))) {
        return this.update(task, { status: 'error', retryable: false, error: 'This file type is not allowed' });
      }
      if (!task.uploadId) {
        const init = await uploadApi.initiate({ name: task.name, size: task.size, mimeType: task.file.type || undefined, parentFolderId: task.parentFolderId }, task.controller.signal);
        task.uploadId = init.uploadId;
        task.mode = init.mode;
        task.completedParts.clear();
        if (init.mode === 'multipart') {
          task.partSize = init.partSize;
          task.partCount = init.partCount;
        } else {
          await this.runSingle(task, init.url, init.headers);
        }
      } else if (task.mode === 'single') {
        const fresh = await uploadApi.refreshUrl(task.uploadId);
        await this.runSingle(task, fresh.url, fresh.headers);
      }
      if (task.mode === 'multipart') await this.runMultipart(task);
      if (task.controller.signal.aborted) return;
      this.update(task, { status: 'done', loaded: task.size });
      this.onUploaded(task.parentFolderId);
    } catch (err) {
      if (err instanceof CancelledError || task.controller.signal.aborted) return;
      const restartable = err instanceof ApiError && ['UPLOAD_EXPIRED', 'UPLOAD_STATE'].includes(err.code);
      const terminal = err instanceof ApiError && ['UNSUPPORTED_FILE_TYPE', 'FILE_TOO_LARGE'].includes(err.code) && !task.uploadId;
      if (restartable || (err instanceof ApiError && err.status === 422)) {
        // The server session is gone or rejected the bytes: a retry starts a fresh upload.
        task.uploadId = undefined;
        task.completedParts.clear();
      }
      this.update(task, { status: 'error', retryable: !terminal, error: describe(err) });
    } finally {
      this.pump();
    }
  }

  private async runSingle(task: Internal, url: string, headers: Record<string, string>) {
    this.update(task, { status: 'uploading' });
    let currentUrl = url;
    for (let attempt = 1; ; attempt++) {
      try {
        await putToStorage(task, currentUrl, task.file, headers, (loaded) => this.update(task, { loaded }));
        break;
      } catch (err) {
        if (err instanceof CancelledError || attempt >= MAX_ATTEMPTS) throw err;
        // Network drop, expired URL (403) or throttling: back off and retry with a fresh URL.
        await sleep(1000 * 2 ** (attempt - 1), task.controller.signal);
        this.update(task, { loaded: 0 });
        currentUrl = (await uploadApi.refreshUrl(task.uploadId!)).url;
      }
    }
    this.update(task, { status: 'verifying', loaded: task.size });
    await uploadApi.complete(task.uploadId!);
  }

  private async runMultipart(task: Internal) {
    this.update(task, { status: 'uploading' });
    for (let round = 0; round < 3; round++) {
      const pending: number[] = [];
      for (let n = 1; n <= task.partCount!; n++) if (!task.completedParts.has(n)) pending.push(n);
      await this.uploadParts(task, pending);
      this.update(task, { status: 'verifying' });
      try {
        await uploadApi.completeMultipart(task.uploadId!, [...task.completedParts].map(([partNumber, etag]) => ({ partNumber, etag })));
        return;
      } catch (err) {
        const missing = err instanceof ApiError ? (err.details?.missingParts as number[] | undefined) : undefined;
        if (!missing?.length) throw err;
        missing.forEach((n) => task.completedParts.delete(n));
        this.update(task, { status: 'uploading' });
      }
    }
    throw new Error('Some parts could not be uploaded. Try again.');
  }

  private async uploadParts(task: Internal, partNumbers: number[]) {
    const queue = [...partNumbers];
    const urls = new Map<number, string>();
    const progress = () => {
      let loaded = 0;
      for (const n of task.completedParts.keys()) loaded += this.partLength(task, n);
      for (const v of task.inflight.values()) loaded += v;
      this.update(task, { loaded: Math.min(loaded, task.size) });
    };
    const fetchUrls = async (nums: number[]) => {
      const { parts } = await uploadApi.partUrls(task.uploadId!, nums);
      parts.forEach((p) => urls.set(p.partNumber, p.url));
    };
    const worker = async () => {
      for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
        const start = (n - 1) * task.partSize!;
        const blob = task.file.slice(start, start + this.partLength(task, n));
        for (let attempt = 1; ; attempt++) {
          if (!urls.has(n)) await fetchUrls([n, ...queue.slice(0, 9)]);
          try {
            const etag = await putToStorage(task, urls.get(n)!, blob, {}, (loaded) => {
              task.inflight.set(n, loaded);
              progress();
            });
            if (!etag) throw new Error('Storage did not return an ETag. The bucket CORS rule must expose the ETag header.');
            task.inflight.delete(n);
            task.completedParts.set(n, etag);
            progress();
            break;
          } catch (err) {
            task.inflight.delete(n);
            urls.delete(n);
            if (err instanceof CancelledError || !(err instanceof HttpError) || attempt >= MAX_ATTEMPTS) throw err;
            await sleep(1000 * 2 ** (attempt - 1), task.controller.signal);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_PARTS, queue.length) }, worker));
  }

  private partLength(task: Internal, n: number) {
    return n === task.partCount ? task.size - task.partSize! * (task.partCount! - 1) : task.partSize!;
  }
}

function describe(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof HttpError) {
    if (err.status === 0) return 'Network error while uploading. Check your connection and retry.';
    if (err.status === 403) return 'The upload link expired. Retry to get a new one.';
    return `Upload failed (storage error ${err.status}). Retry to try again.`;
  }
  return err instanceof Error ? err.message : 'Upload failed';
}
