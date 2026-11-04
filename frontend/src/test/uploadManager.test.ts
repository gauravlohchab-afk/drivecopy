import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UploadManager, type UploadTask } from '../uploads/uploadManager';

// Minimal XMLHttpRequest stand-in: each PUT is resolved by the test (success, progress or failure).
class FakeXHR {
  static instances: FakeXHR[] = [];
  upload: { onprogress: ((e: { loaded: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  url = '';
  headers: Record<string, string> = {};
  constructor() {
    FakeXHR.instances.push(this);
  }
  open(_m: string, url: string) {
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send() {}
  abort() {
    this.onabort?.();
  }
  getResponseHeader(name: string) {
    return name === 'ETag' ? '"etag"' : null;
  }
  progress(loaded: number) {
    this.upload.onprogress?.({ loaded });
  }
  succeed() {
    this.status = 200;
    this.onload?.();
  }
  networkError() {
    this.onerror?.();
  }
}

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

let calls: string[];
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  FakeXHR.instances = [];
  calls = [];
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push(`${init.method} ${url}`);
    if (url === '/api/uploads/policy') return json({ maxFileSize: 1000, multipartThreshold: 500, allowedExtensions: ['pdf'], urlTtlSeconds: 900 });
    if (url === '/api/uploads/initiate') return json({ uploadId: 'u1', fileId: 'f1', mode: 'single', url: 'https://s3.example/put?sig=1', headers: { 'Content-Type': 'application/pdf' } }, 201);
    if (url === '/api/uploads/u1/url') return json({ url: 'https://s3.example/put?sig=2', headers: { 'Content-Type': 'application/pdf' } });
    if (url === '/api/uploads/u1/complete') return json({ status: 'completed', file: { id: 'f1' } });
    if (url === '/api/uploads/u1/cancel') return json({ status: 'cancelled' });
    return json({ error: { code: 'NOT_FOUND', message: 'nope' } }, 404);
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const until = async (fn: () => boolean) => {
  for (let i = 0; i < 200 && !fn(); i++) await vi.advanceTimersByTimeAsync(20);
  expect(fn()).toBe(true);
};

const pdf = (size: number, name = 'a.pdf') => new File([new Uint8Array(size)], name, { type: 'application/pdf' });

describe('UploadManager', () => {
  it('rejects disallowed types and oversized files before contacting storage', async () => {
    const m = new UploadManager(() => undefined);
    m.add([pdf(10, 'x.exe'), pdf(5000)], null);
    await until(() => m.getSnapshot().every((t) => t.status === 'error'));
    const [a, b] = m.getSnapshot() as [UploadTask, UploadTask];
    expect(a.error).toMatch(/not allowed/);
    expect(a.retryable).toBe(false);
    expect(b.error).toMatch(/larger than/);
    expect(calls.some((c) => c.includes('initiate'))).toBe(false);
  });

  it('reports real XHR progress, then completes only after the server verifies', async () => {
    const done = vi.fn();
    const m = new UploadManager(done);
    m.add([pdf(400)], 'folder1');
    await until(() => FakeXHR.instances.length === 1);
    const xhr = FakeXHR.instances[0]!;
    expect(xhr.headers['Content-Type']).toBe('application/pdf');
    xhr.progress(100);
    expect(m.getSnapshot()[0]).toMatchObject({ status: 'uploading', loaded: 100 });
    expect(done).not.toHaveBeenCalled();
    xhr.succeed();
    await until(() => m.getSnapshot()[0]!.status === 'done');
    expect(calls).toContain('POST /api/uploads/u1/complete');
    expect(done).toHaveBeenCalledWith('folder1');
  });

  it('retries after a network failure with a fresh presigned URL', async () => {
    const m = new UploadManager(() => undefined);
    m.add([pdf(400)], null);
    await until(() => FakeXHR.instances.length === 1);
    FakeXHR.instances[0]!.networkError();
    await until(() => FakeXHR.instances.length === 2);
    expect(calls).toContain('POST /api/uploads/u1/url');
    expect(FakeXHR.instances[1]!.url).toContain('sig=2');
    FakeXHR.instances[1]!.succeed();
    await until(() => m.getSnapshot()[0]!.status === 'done');
  });

  it('cancels: aborts the transfer and tells the server to release the upload', async () => {
    const m = new UploadManager(() => undefined);
    m.add([pdf(400)], null);
    await until(() => FakeXHR.instances.length === 1);
    m.cancel(m.getSnapshot()[0]!.id);
    expect(m.getSnapshot()[0]!.status).toBe('cancelled');
    await until(() => calls.includes('POST /api/uploads/u1/cancel'));
    expect(calls).not.toContain('POST /api/uploads/u1/complete');
  });
});
