/** Per-device UI preferences only (view mode, sort). Never used for data. */
export function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(`cirrus:${key}`);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}
export function writePref(key: string, value: string) {
  try {
    localStorage.setItem(`cirrus:${key}`, value);
  } catch {
    // ignore (private mode, storage disabled)
  }
}
