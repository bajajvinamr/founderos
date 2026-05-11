// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { displayLabel, type DisplayMode } from '@founderos/shared';
import { useDisplayMode } from './use-display';

const STORAGE_KEY = 'founderos.viewMode';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Renders a probe component that exposes the current hook state via a ref
 * passed in by the test. Avoids pulling in @testing-library/react which is
 * not part of the existing UI test surface.
 */
function renderUseDisplayModeProbe(): {
  container: HTMLDivElement;
  root: Root;
  ref: { mode: DisplayMode; setMode: (next: DisplayMode) => void };
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  // Filled by the probe component on every render.
  const ref: { mode: DisplayMode; setMode: (next: DisplayMode) => void } = {
    mode: 'founder',
    setMode: () => {},
  };

  function Probe() {
    const [mode, setMode] = useDisplayMode();
    ref.mode = mode;
    ref.setMode = setMode;
    return null;
  }

  act(() => {
    root.render(createElement(Probe));
  });

  return { container, root, ref };
}

describe('useDisplay hook integration', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('should use founder mode by default', () => {
    const label = displayLabel('issue', 'founder');
    expect(label).toBe('Task');
  });

  it('should use engineer mode when specified', () => {
    const label = displayLabel('issue', 'engineer');
    expect(label).toBe('Issue');
  });

  it('should handle provider labels in founder mode', () => {
    expect(displayLabel('anthropic_api', 'founder')).toBe('Claude (pay-per-use)');
    expect(displayLabel('claude_local', 'founder')).toBe('Claude (subscription)');
    expect(displayLabel('openai_api', 'founder')).toBe('ChatGPT (pay-per-use)');
  });

  it('should handle provider labels in engineer mode', () => {
    expect(displayLabel('anthropic_api', 'engineer')).toBe('Anthropic API');
    expect(displayLabel('claude_local', 'engineer')).toBe('Claude Code CLI');
    expect(displayLabel('openai_api', 'engineer')).toBe('OpenAI API');
  });

  it('should handle section headers correctly', () => {
    expect(displayLabel('agents', 'founder')).toBe('Your team');
    expect(displayLabel('agents', 'engineer')).toBe('Agents');
    expect(displayLabel('integrations', 'founder')).toBe('Connections');
    expect(displayLabel('integrations', 'engineer')).toBe('Integrations');
  });

  it('should handle localStorage key pattern for cross-tab sync', () => {
    // Verify that localStorage key is correctly named for cross-tab sync
    const testKey = STORAGE_KEY;
    expect(testKey).toBe('founderos.viewMode');

    // Simulate storing a mode and retrieving it
    localStorage.setItem(testKey, 'engineer');
    const stored = localStorage.getItem(testKey);
    expect(stored).toBe('engineer');
  });

  it('should support both founder and engineer modes as valid values', () => {
    const validModes = ['founder', 'engineer'] as const;

    for (const mode of validModes) {
      const label = displayLabel('issue', mode);
      expect(label).toBeDefined();
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('should provide consistent labels across multiple calls', () => {
    const label1 = displayLabel('issue', 'founder');
    const label2 = displayLabel('issue', 'founder');
    expect(label1).toBe(label2);

    const label3 = displayLabel('issue', 'engineer');
    const label4 = displayLabel('issue', 'engineer');
    expect(label3).toBe(label4);
  });

  it('should handle all dictionary keys without errors', () => {
    const keys = [
      'issue', 'issues', 'adapter', 'run', 'runs', 'heartbeat',
      'workspace', 'claim', 'wakeup', 'routine', 'routines', 'audit',
      'byo_runner', 'anthropic_api', 'claude_local', 'openai_api',
      'codex_local', 'gemini_api', 'gemini_local', 'new_issue',
      'create_issue', 'ask_action', 'agents', 'integrations',
      'providers', 'decisions', 'inbox'
    ] as const;

    for (const key of keys) {
      const founderLabel = displayLabel(key, 'founder');
      const engineerLabel = displayLabel(key, 'engineer');

      expect(founderLabel).toBeDefined();
      expect(engineerLabel).toBeDefined();
      expect(typeof founderLabel).toBe('string');
      expect(typeof engineerLabel).toBe('string');
    }
  });
});

// BL-012 (P4.a): write-side hook coverage. #169 shipped the read side; this
// block exercises the setter, default-to-founder behavior for new users, and
// cross-tab StorageEvent sync.
describe('useDisplayMode hook (BL-012 / P4.a)', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root!.unmount();
      });
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
    localStorage.clear();
  });

  it('defaults to "founder" for new users (no localStorage entry)', () => {
    const probe = renderUseDisplayModeProbe();
    container = probe.container;
    root = probe.root;

    expect(probe.ref.mode).toBe('founder');
  });

  it('reads existing engineer mode from localStorage on mount', () => {
    localStorage.setItem(STORAGE_KEY, 'engineer');

    const probe = renderUseDisplayModeProbe();
    container = probe.container;
    root = probe.root;

    expect(probe.ref.mode).toBe('engineer');
  });

  it('setMode persists to localStorage and updates the returned mode', () => {
    const probe = renderUseDisplayModeProbe();
    container = probe.container;
    root = probe.root;

    expect(probe.ref.mode).toBe('founder');
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    act(() => {
      probe.ref.setMode('engineer');
    });

    expect(probe.ref.mode).toBe('engineer');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('engineer');

    act(() => {
      probe.ref.setMode('founder');
    });

    expect(probe.ref.mode).toBe('founder');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('founder');
  });

  it('reacts to cross-tab storage events (mode flipped in another tab)', () => {
    const probe = renderUseDisplayModeProbe();
    container = probe.container;
    root = probe.root;

    expect(probe.ref.mode).toBe('founder');

    // Simulate another tab writing the key. jsdom does not auto-fire a
    // StorageEvent for same-window setItem, so we dispatch it manually —
    // which is exactly what cross-tab sync looks like in real browsers.
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: STORAGE_KEY,
          newValue: 'engineer',
          oldValue: null,
        }),
      );
    });

    expect(probe.ref.mode).toBe('engineer');
  });

  it('ignores storage events for unrelated keys', () => {
    const probe = renderUseDisplayModeProbe();
    container = probe.container;
    root = probe.root;

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'some.other.key',
          newValue: 'engineer',
          oldValue: null,
        }),
      );
    });

    expect(probe.ref.mode).toBe('founder');
  });

  it('ignores storage events with invalid values', () => {
    localStorage.setItem(STORAGE_KEY, 'engineer');
    const probe = renderUseDisplayModeProbe();
    container = probe.container;
    root = probe.root;

    expect(probe.ref.mode).toBe('engineer');

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: STORAGE_KEY,
          newValue: 'not-a-mode',
          oldValue: 'engineer',
        }),
      );
    });

    // Stays at engineer — invalid newValue is ignored, not collapsed to default.
    expect(probe.ref.mode).toBe('engineer');
  });

  it('treats unknown stored values as default founder mode', () => {
    localStorage.setItem(STORAGE_KEY, 'gibberish');

    const probe = renderUseDisplayModeProbe();
    container = probe.container;
    root = probe.root;

    expect(probe.ref.mode).toBe('founder');
  });
});
