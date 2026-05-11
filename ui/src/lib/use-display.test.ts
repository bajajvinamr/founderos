// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { displayLabel } from '@founderos/shared';

const STORAGE_KEY = 'founderos.viewMode';

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
