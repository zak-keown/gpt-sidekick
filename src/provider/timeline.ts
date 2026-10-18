export interface TimelineOptions {
  scroller: { scrollTop: number; scrollHeight: number; clientHeight: number };
  observe(): { keys: string[]; found?: boolean; pending?: boolean };
  valid(): boolean;
  pause?(ms: number): Promise<void>;
  now?(): number;
  maxMs?: number;
  maxSteps?: number;
  settleMs?: number;
  boundaryWaitMs?: number;
}

export interface TimelineResult {
  reason: 'end' | 'found' | 'cancelled' | 'limit';
  topConfirmed: boolean;
  bottomConfirmed: boolean;
  samples: number;
}

/** Visits virtual windows without retaining nodes or restoring the viewport. */
export async function walkTimeline(options: TimelineOptions): Promise<TimelineResult> {
  const { scroller } = options;
  const now = options.now ?? Date.now;
  const pause = options.pause ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const started = now();
  const maxMs = options.maxMs ?? 45000;
  const maxSteps = options.maxSteps ?? 2000;
  const settleMs = Math.max(1, options.settleMs ?? 120);
  const boundaryWaitMs = Math.max(0, options.boundaryWaitMs ?? 1200);
  let samples = 0;
  let topConfirmed = false;
  let bottomConfirmed = false;
  const result = (reason: TimelineResult['reason']): TimelineResult => ({ reason, topConfirmed, bottomConfirmed, samples });
  const limited = () => samples >= maxSteps || now() - started >= maxMs;
  const sample = () => {
    samples++;
    const observation = options.observe();
    return { ...observation, signature: JSON.stringify([scroller.scrollHeight, scroller.clientHeight, scroller.scrollTop, observation.keys]) };
  };
  if (!options.valid()) return result('cancelled');
  if (limited()) return result('limit');
  let observed = sample();
  if (!options.valid()) return result('cancelled');
  if (observed.found) return result('found');
  let signature = observed.signature;
  let stableSince = now();
  while (!topConfirmed) {
    if (!options.valid()) return result('cancelled');
    if (limited()) return result('limit');
    scroller.scrollTop = 0;
    await pause(settleMs);
    if (!options.valid()) return result('cancelled');
    if (limited()) return result('limit');
    observed = sample();
    if (!options.valid()) return result('cancelled');
    if (observed.found) return result('found');
    if (observed.signature !== signature || observed.pending || scroller.scrollTop > 2) {
      signature = observed.signature;
      stableSince = now();
    }
    topConfirmed = scroller.clientHeight > 0 && scroller.scrollHeight > 0 && observed.keys.length > 0 && scroller.scrollTop <= 2 && !observed.pending && now() - stableSince >= boundaryWaitMs;
  }
  signature = '';
  stableSince = now();
  while (!bottomConfirmed) {
    if (!options.valid()) return result('cancelled');
    if (limited()) return result('limit');
    const oldHeight = scroller.scrollHeight;
    const maximum = Math.max(0, oldHeight - scroller.clientHeight);
    const requested = Math.min(maximum, Math.max(0, scroller.scrollTop) + Math.max(100, scroller.clientHeight * 0.7));
    scroller.scrollTop = requested;
    await pause(settleMs);
    if (!options.valid()) return result('cancelled');
    if (limited()) return result('limit');
    observed = sample();
    if (!options.valid()) return result('cancelled');
    if (observed.found) return result('found');
    // Anchored prepends invalidate the top boundary established above.
    if (scroller.scrollHeight < oldHeight || (scroller.scrollHeight > oldHeight && scroller.scrollTop > requested + 2)) {
      topConfirmed = false;
      return result('limit');
    }
    const atBottom = scroller.scrollTop >= Math.max(0, scroller.scrollHeight - scroller.clientHeight) - 2;
    if (!atBottom || observed.signature !== signature || observed.pending) {
      signature = observed.signature;
      stableSince = now();
    }
    bottomConfirmed = atBottom && scroller.clientHeight > 0 && observed.keys.length > 0 && !observed.pending && now() - stableSince >= boundaryWaitMs;
  }
  return result('end');
}
