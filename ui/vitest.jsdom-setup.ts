/**
 * Node.js 22+ ships a broken built-in `localStorage` (no clear/getItem/etc).
 * This setup runs inside each jsdom test worker and installs a proper
 * spec-compliant Storage shim when the built-in is detected.
 */

function isNodeBuiltinStorage(obj: unknown): boolean {
  return (
    typeof obj === "object" &&
    obj !== null &&
    typeof (obj as Storage).clear !== "function"
  );
}

if (isNodeBuiltinStorage(globalThis.localStorage)) {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return [...store.keys()][index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    writable: true,
    configurable: true,
  });
}
