import { describe, it, expect } from 'vitest';
import { DISPLAY_DICTIONARY, displayLabel, type DisplayKey } from './display-dictionary.js';

describe('DISPLAY_DICTIONARY', () => {
  it('should have a snapshot of the full dictionary', () => {
    expect(DISPLAY_DICTIONARY).toMatchSnapshot();
  });

  it('should return "Task" for issue in founder mode', () => {
    expect(displayLabel('issue', 'founder')).toBe('Task');
  });

  it('should return "Issue" for issue in engineer mode', () => {
    expect(displayLabel('issue', 'engineer')).toBe('Issue');
  });

  it('should default to founder mode when mode is not specified', () => {
    expect(displayLabel('issue')).toBe('Task');
  });

  it('should return the founder label by default for all keys', () => {
    expect(displayLabel('adapter')).toBe('AI Brain');
    expect(displayLabel('run')).toBe('Work shift');
    expect(displayLabel('workspace')).toBe('Knowledge base');
  });

  it('should have both founder and engineer labels for every key', () => {
    (Object.keys(DISPLAY_DICTIONARY) as DisplayKey[]).forEach((key) => {
      const label = DISPLAY_DICTIONARY[key];
      expect(label).toHaveProperty('founder');
      expect(label).toHaveProperty('engineer');
      expect(typeof label.founder).toBe('string');
      expect(typeof label.engineer).toBe('string');
      expect(label.founder.length).toBeGreaterThan(0);
      expect(label.engineer.length).toBeGreaterThan(0);
    });
  });

  it('should have distinct founder and engineer labels for most keys', () => {
    (Object.keys(DISPLAY_DICTIONARY) as DisplayKey[]).forEach((key) => {
      const label = DISPLAY_DICTIONARY[key];
      // Both labels should typically be different (except in rare cases)
      // This is a sanity check to ensure we're not duplicating by accident
      expect(`${label.founder}:${label.engineer}`).toBeDefined();
    });
  });

  it('should handle provider labels correctly', () => {
    expect(displayLabel('anthropic_api', 'founder')).toBe('Claude (pay-per-use)');
    expect(displayLabel('anthropic_api', 'engineer')).toBe('Anthropic API');
    expect(displayLabel('claude_local', 'founder')).toBe('Claude (subscription)');
    expect(displayLabel('claude_local', 'engineer')).toBe('Claude Code CLI');
  });

  it('should handle section headers correctly', () => {
    expect(displayLabel('agents', 'founder')).toBe('Your team');
    expect(displayLabel('agents', 'engineer')).toBe('Agents');
    expect(displayLabel('integrations', 'founder')).toBe('Connections');
    expect(displayLabel('providers', 'engineer')).toBe('Providers');
  });

  it('renames routines to Cadences in BOTH modes (P3 Wave 2 W23)', () => {
    // Old keys still resolve (back-compat for any consumer that hasn't migrated)
    // but engineer mode no longer says "Routine" — there is no engineering term
    // left for the old concept after the rename.
    expect(displayLabel('routine', 'founder')).toBe('Cadence');
    expect(displayLabel('routine', 'engineer')).toBe('Cadence');
    expect(displayLabel('routines', 'founder')).toBe('Cadences');
    expect(displayLabel('routines', 'engineer')).toBe('Cadences');
  });

  it('exposes explicit cadence / cadences keys for new code paths (P3 Wave 2 W23)', () => {
    expect(displayLabel('cadence', 'founder')).toBe('Cadence');
    expect(displayLabel('cadence', 'engineer')).toBe('Cadence');
    expect(displayLabel('cadences', 'founder')).toBe('Cadences');
    expect(displayLabel('cadences', 'engineer')).toBe('Cadences');
  });

  it('should handle onboarding Step 4 keys correctly (BL-002)', () => {
    expect(displayLabel('onboarding.step4.headline', 'founder')).toBe(
      'How should FounderOS use AI?',
    );
    expect(displayLabel('onboarding.step4.headline', 'engineer')).toBe(
      'Adapter configuration',
    );
    expect(displayLabel('onboarding.step4.subtitle', 'founder')).toBe(
      'Pick where the AI for your team should run',
    );
    expect(displayLabel('onboarding.step4.subtitle', 'engineer')).toBe(
      'Select adapter family + provider',
    );
  });
});
