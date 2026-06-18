import { describe, it, expect } from 'vitest';
import { findConsentDismiss } from '@/agent/tools/browser/consent';

const WALL_BOTH =
  `   heading "We value your privacy"\n` +
  `   text "We use cookies to improve your experience."\n` +
  `[1] button "Accept all"\n` +
  `[2] button "Reject all"\n` +
  `[3] button "Manage settings"`;

const WALL_ACCEPT_ONLY =
  `   text "This site uses cookies."\n` +
  `[1] button "Accept"\n` +
  `[2] button "Cookie settings"`;

const WALL_MANAGE_ONLY =
  `   heading "Your privacy"\n` +
  `   text "We use cookies."\n` +
  `[1] button "Manage options"`;

const NORMAL =
  `   heading "Checkout"\n` +
  `[1] button "Accept"\n` + // "Accept" but NO consent context
  `[2] textbox "Card number"`;

describe('findConsentDismiss', () => {
  it('prefers reject over accept on a consent wall (privacy)', () => {
    expect(findConsentDismiss(WALL_BOTH)).toEqual({ index: 2, label: 'Reject all', kind: 'reject' });
  });
  it('falls back to accept when no reject option exists', () => {
    expect(findConsentDismiss(WALL_ACCEPT_ONLY)).toEqual({ index: 1, label: 'Accept', kind: 'accept' });
  });
  it('returns null when only manage/settings exists (no direct dismiss to click)', () => {
    expect(findConsentDismiss(WALL_MANAGE_ONLY)).toBeNull();
  });
  it('returns null on a normal page even with an "Accept" button (no consent context)', () => {
    expect(findConsentDismiss(NORMAL)).toBeNull();
  });
});
