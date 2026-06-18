import { describe, it, expect, vi } from 'vitest';
import { createPortClient } from '@/sidepanel/port';
import type { SwUpdate } from '@/shared/messages';

interface FakePort {
  postMessage: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (f: (m: unknown) => void) => void };
  onDisconnect: { addListener: (f: () => void) => void };
  emitMessage: (m: unknown) => void;
  emitDisconnect: () => void;
}

function fakePort(): FakePort {
  const msg: Array<(m: unknown) => void> = [];
  const disc: Array<() => void> = [];
  return {
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: { addListener: (f) => void msg.push(f) },
    onDisconnect: { addListener: (f) => void disc.push(f) },
    emitMessage: (m) => msg.forEach((f) => f(m)),
    emitDisconnect: () => disc.forEach((f) => f()),
  };
}

describe('createPortClient', () => {
  it('connects lazily on the first send and posts the command', () => {
    const p = fakePort();
    const connect = vi.fn(() => p as unknown as chrome.runtime.Port);
    const client = createPortClient(() => undefined, connect);
    client.send({ type: 'agent.status' });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(p.postMessage).toHaveBeenCalledWith({ type: 'agent.status' });
  });

  it('reconnects on the next send after the SW disconnects (the "Run does nothing" bug)', () => {
    const p1 = fakePort();
    const p2 = fakePort();
    const queue = [p1, p2];
    const connect = vi.fn(() => queue.shift()! as unknown as chrome.runtime.Port);
    const client = createPortClient(() => undefined, connect);

    client.send({ type: 'agent.status' }); // opens port #1
    // MV3 idle-kills the SW → its port disconnects. A naive client nulls the port
    // and never reconnects, so every later send() is silently dropped → "Run does nothing".
    p1.emitDisconnect();

    client.send({ type: 'agent.start', goal: 'x' }); // must revive the connection
    expect(connect).toHaveBeenCalledTimes(2);
    expect(p2.postMessage).toHaveBeenCalledWith({ type: 'agent.start', goal: 'x' });
  });

  it('routes SW updates to the onUpdate handler', () => {
    const p = fakePort();
    const updates: SwUpdate[] = [];
    const client = createPortClient(
      (m) => void updates.push(m),
      () => p as unknown as chrome.runtime.Port,
    );
    client.send({ type: 'agent.status' });
    p.emitMessage({
      type: 'status',
      status: { phase: 'IDLE', goal: null, plan: null, currentStepId: null, replanCount: 0, ownedTabs: [] },
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].type).toBe('status');
  });
});
