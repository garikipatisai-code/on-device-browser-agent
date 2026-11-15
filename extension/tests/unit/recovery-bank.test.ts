// T8 PALADIN recovery bank (BRAIN TDD) — error-signature → single-step fix,
// tried before a full replan on evaluator FAIL; unknown signatures fall back.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lookupRecovery, RECOVERY_BANK } from '@/agent/workflow_memory';
import { Orchestrator } from '@/agent/orchestrator';
import { ToolRegistry } from '@/agent/tools/registry';
import { DEFAULT_SETTINGS } from '@/shared/messages';
import { makeFakeOllama } from '../helpers';

// 55 error signatures → each must resolve to a single-step (<1 replan) fix.
// Each reason embeds its bank pattern verbatim (case may vary); the expected
// snippet is a keyword that must appear in the returned fix.
const CASES: Array<[string, string]> = [
  ['aria.extract returned empty content on the product page', 're-read'],
  ['aria.extract timed out waiting for the page to settle', 'wait'],
  ['vision.read returned blank screenshot, page may be canvas', 'vision'],
  ['tab.click failed: element is no longer attached to the DOM', 're-read'],
  ['tab.click failed: element not clickable at point', 'scroll'],
  ['tab.click failed: click index out of range for this page', 're-read'],
  ['tab.type failed: type target field not found on page', 're-read'],
  ['tab.type failed: field is readonly, cannot type', 'readonly'],
  ['tab.select failed: select option not found in dropdown', 'option'],
  ['upload failed: no file chosen for the upload field', 'upload_file'],
  ['navigation failed: blocked url per domain tiers', 'domain'],
  ['navigation failed: invalid scheme for tab.open', 'http'],
  ['navigation failed: navigation timeout after 30s', 'wait'],
  ['read failed: no active tab to read', 'open'],
  ['scroll: reached end of page, no more content to load', 'report'],
  ['search returned no results for the query', 'query'],
  ['search failed: search query was empty', 'query'],
  ['search failed: search rate limited, back off', 'wait'],
  ['open_result failed: open_result index out of range', 'search'],
  ['open_result failed: no prior search in this task', 'search'],
  ['page blocked by consent overlay, dismiss first', 'consent'],
  ['page blocked by captcha wall, needs human', 'human'],
  ['action denied: read-only domain for this site', 'read-only'],
  ['action denied: click requires upgrade on this domain', 'upgrade'],
  ['navigation denied: blocked scheme chrome://', 'scheme'],
  ['evaluator FAIL: ungrounded number in finish summary', 'grounded'],
  ['evaluator FAIL: field reported absent but seen earlier', 'corpus'],
  ['evaluator FAIL: wrong page, not the product page', 'back'],
  ['evaluator FAIL: list incomplete, only first items shown', 'scroll'],
  ['evaluator FAIL: mixed comparison basis across sites', 'anchor'],
  ['evaluator FAIL: vague range instead of a precise figure', 'precise'],
  ['evaluator FAIL: hallucinated phone number not on page', 'shown'],
  ['evaluator FAIL: no citation for the reported facts', 'cite'],
  ['evaluator FAIL: prose answer not grounded in observations', 'grounded'],
  ['evaluator FAIL: finish not in workspace observations', 'workspace'],
  ['breaker trip: repeated same tool call in a loop', 'different'],
  ['breaker trip: unknown tool loop detected', 'catalog'],
  ['executor produced no tool call this turn', 'tool'],
  ['loop: aria.extract back-to-back without acting', 'act'],
  ['planner FAIL: plan has no steps to execute', 'replan'],
  ['planner FAIL: replan limit approaching, salvage instead', 'salvage'],
  ['tab operation failed: no such tab id', 'open'],
  ['page fetch failed: network error fetching page', 'retry'],
  ['auto-read empty: page still loading after navigation', 'wait'],
  ['verify FAIL: workspace entry missing for cited fact', 'workspace'],
  ['context pressure: scratchpad overflow, compacted', 'compact'],
  ['finish blocked but facts gathered from snippets', 'salvage'],
  ['finish failed but answer in corpus from earlier reads', 'corpus'],
  ['page wall: login required to continue', 'human'],
  ['page wall: subscribe to read the full article', 'snippet'],
  ['form fill: submit button not found on page', 're-read'],
  ['form fill: file input is hidden on this page', 'upload_file'],
  ['extract: rating graphic with no number shown', 'not shown'],
  ['extract: table too large, find the specific row', 'row'],
  ['convert: value computed mentally instead of looked up', 'search'],
];

describe('recovery bank — 55 error signatures → single-step fix', () => {
  it('bank holds at least 55 entries', () => {
    expect(RECOVERY_BANK.length).toBeGreaterThanOrEqual(55);
  });

  it.each(CASES)('resolves "%s"', (reason, snippet) => {
    const hit = lookupRecovery(reason);
    expect(hit).not.toBeNull();
    // <1-step fix: a single short steer instruction (no replan, no multi-part plan).
    expect(hit!.fix.length).toBeGreaterThan(10);
    expect(hit!.fix.length).toBeLessThan(300);
    expect(hit!.fix).not.toContain('\n\n');
    expect(hit!.fix.toLowerCase()).toContain(snippet);
  });

  it('matches case-insensitively', () => {
    const hit = lookupRecovery('SEARCH RETURNED NO RESULTS FOR THE QUERY');
    expect(hit).not.toBeNull();
  });

  it('unknown signatures fall back (null)', () => {
    expect(lookupRecovery('qubit flux destabilized the warp core')).toBeNull();
    expect(lookupRecovery('')).toBeNull();
    expect(lookupRecovery('everything went fine, nothing to fix')).toBeNull();
  });
});

function makeOrch(): Orchestrator {
  return new Orchestrator({
    ollama: makeFakeOllama({}),
    registry: new ToolRegistry(),
    settings: { ...DEFAULT_SETTINGS },
    emit: () => undefined,
  });
}

describe('tryBacktrackBank — fix vs replan', () => {
  it('applies the bank fix (true) for a known signature', () => {
    const orch = makeOrch();
    const ok = (orch as unknown as { tryBacktrackBank: (r: string) => boolean }).tryBacktrackBank(
      'search returned no results for the query — try again',
    );
    expect(ok).toBe(true);
  });

  it('marks the run dirty on a bank recovery', () => {
    const orch = makeOrch();
    (orch as unknown as { tryBacktrackBank: (r: string) => boolean }).tryBacktrackBank(
      'aria.extract returned empty content on the page',
    );
    expect((orch as unknown as { runDirty: boolean }).runDirty).toBe(true);
  });

  it('falls back (false) for an unknown signature', () => {
    const orch = makeOrch();
    const ok = (orch as unknown as { tryBacktrackBank: (r: string) => boolean }).tryBacktrackBank(
      'qubit flux destabilized the warp core',
    );
    expect(ok).toBe(false);
  });
});

describe('FAIL-path wiring — bank hook sits before replan', () => {
  const text = readFileSync(join(process.cwd(), 'src/agent/orchestrator.ts'), 'utf8');

  it('hooks tryBacktrackBank into the FAIL path before replan', () => {
    const failIdx = text.indexOf("ev.verdict === 'FAIL'");
    expect(failIdx).toBeGreaterThan(-1);
    const tail = text.slice(failIdx, failIdx + 1200);
    const hookPos = tail.indexOf('tryBacktrackBank');
    const replanPos = tail.indexOf('this.replan(');
    expect(hookPos).toBeGreaterThan(-1);
    expect(replanPos).toBeGreaterThan(-1);
    expect(hookPos).toBeLessThan(replanPos);
  });

  it('the bank recovery marks the run dirty (no clean-recipe poison)', () => {
    const methodIdx = text.indexOf('private tryBacktrackBank(');
    expect(methodIdx).toBeGreaterThan(-1);
    const tail = text.slice(methodIdx, methodIdx + 800);
    expect(tail).toContain('markDirty');
    expect(tail).toContain('lookupRecovery');
  });
});
