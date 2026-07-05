import { describe, it, expect } from 'vitest';
import { detectAntiBotBlock } from '@/agent/tools/browser/antibot';

const CLOUDFLARE =
  `   heading "Just a moment..."\n` +
  `   text "checking your browser before accessing the site."`;

const GOOGLE_BLOCK =
  `   heading "Sorry..."\n` +
  `   text "Our systems have detected unusual traffic from your computer network."`;

const AKAMAI =
  `   heading "Access Denied"\n` +
  `   text "Pardon the Interruption..."`;

const RECAPTCHA_WIDGET =
  `   text "Please verify you are human"\n` +
  `[1] checkbox "I'm not a robot"\n` +
  `   text "reCAPTCHA"`;

const GENERIC_HUMAN_CHECK =
  `   heading "Security Check"\n` +
  `   text "Please complete the security check to continue."`;

const NORMAL =
  `   heading "Checkout"\n` +
  `[1] button "Place order"\n` +
  `[2] textbox "Card number"`;

describe('detectAntiBotBlock', () => {
  it('detects a Cloudflare browser-check interstitial', () => {
    expect(detectAntiBotBlock(CLOUDFLARE)).toEqual({ label: 'Cloudflare browser check' });
  });
  it("detects Google's automated-traffic block page", () => {
    expect(detectAntiBotBlock(GOOGLE_BLOCK)).toEqual({ label: 'Google automated-traffic block' });
  });
  it('detects an Akamai-style block page', () => {
    expect(detectAntiBotBlock(AKAMAI)).toEqual({ label: 'Akamai bot block' });
  });
  it('detects a reCAPTCHA widget by vendor name (checked before generic phrasing)', () => {
    expect(detectAntiBotBlock(RECAPTCHA_WIDGET)).toEqual({ label: 'CAPTCHA widget' });
  });
  it('detects generic human-verification phrasing with no vendor name present', () => {
    expect(detectAntiBotBlock(GENERIC_HUMAN_CHECK)).toEqual({ label: 'Generic human-verification wall' });
  });
  it('returns null on an ordinary page', () => {
    expect(detectAntiBotBlock(NORMAL)).toBeNull();
  });
});
