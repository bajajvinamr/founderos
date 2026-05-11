import { useEffect, useState, useCallback } from 'react';
import { displayLabel, type DisplayKey, type DisplayMode } from '@founderos/shared';

const STORAGE_KEY = 'founderos.viewMode';
const DEFAULT_MODE: DisplayMode = 'founder';

function readMode(): DisplayMode {
  if (typeof window === 'undefined') return DEFAULT_MODE;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return (stored === 'engineer' || stored === 'founder') ? stored : DEFAULT_MODE;
}

export function useDisplayMode(): [DisplayMode, (mode: DisplayMode) => void] {
  const [mode, setModeState] = useState<DisplayMode>(readMode);

  const setMode = useCallback((next: DisplayMode) => {
    setModeState(next);
    try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* SSR / quota */ }
  }, []);

  useEffect(() => {
    // Cross-tab sync — if another tab flips the mode, reflect it here.
    const handler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && (e.newValue === 'engineer' || e.newValue === 'founder')) {
        setModeState(e.newValue);
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  return [mode, setMode];
}

export function useDisplay(key: DisplayKey): string {
  const [mode] = useDisplayMode();
  return displayLabel(key, mode);
}
