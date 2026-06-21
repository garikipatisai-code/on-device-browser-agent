// Timeline persistence across the MV3 service-worker kill.
//
// The activity timeline lives in the service worker's memory (`_events` in background/index.ts).
// Chrome force-kills the idle SW (~30s); when it restarts, that array is empty — so after a run
// the Activity log (and its Copy button) would vanish the moment the user next touches the panel.
// Mirror the timeline into chrome.storage.session: in-memory-backed (fast), survives SW recycling
// within the browser session, cleared on browser restart, and NEVER written to disk — so it keeps
// the privacy promise while making a finished run reliably viewable + copyable.

import type { TimelineEvent } from '@/shared/messages';

const KEY = 'timeline:last';

/** Fire-and-forget mirror of the current timeline. Guarded: storage.session is absent in older
 *  Chrome / non-extension contexts, where this is simply a no-op. */
export function persistTimeline(events: TimelineEvent[]): void {
  try {
    void chrome.storage?.session?.set({ [KEY]: events });
  } catch {
    /* best effort — never let persistence break a run */
  }
}

/** Restore the last-known timeline (e.g. after the SW was killed and restarted). Empty if none. */
export async function loadTimeline(): Promise<TimelineEvent[]> {
  try {
    const got = await chrome.storage?.session?.get(KEY);
    const saved = got?.[KEY];
    return Array.isArray(saved) ? (saved as TimelineEvent[]) : [];
  } catch {
    return [];
  }
}

/** Drop the persisted timeline (used on reset). */
export function clearPersistedTimeline(): void {
  try {
    void chrome.storage?.session?.remove(KEY);
  } catch {
    /* best effort */
  }
}
