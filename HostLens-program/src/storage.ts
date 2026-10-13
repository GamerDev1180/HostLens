// localStorage helpers that never throw: storage can be unavailable or hold
// data from an older version of the app.

export function loadJson<T>(key: string, fallback: T, valid: (value: unknown) => boolean): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return valid(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable; the value just won't persist.
  }
}
