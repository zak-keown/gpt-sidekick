import { expect, it } from 'vitest';
import { walkTimeline, type TimelineOptions } from '../src/provider/timeline';

function fixture(extra: Partial<TimelineOptions> = {}) {
  let clock = 0;
  const scroller = { scrollTop: 800, scrollHeight: 1000, clientHeight: 200 };
  const visited = new Set<number>();
  const options: TimelineOptions = { scroller, valid: () => true, now: () => clock,
    pause: async ms => { clock += ms; }, settleMs: 10, boundaryWaitMs: 20,
    observe: () => { const position = Math.floor(scroller.scrollTop / 100); visited.add(position); return { keys: [`turn-${position}`] }; }, ...extra };
  return { options, scroller, visited };
}

it('visits replacing windows and waits for stable top and bottom boundaries', async () => {
  const { options, visited, scroller } = fixture();
  expect(await walkTimeline(options)).toMatchObject({ reason: 'end', topConfirmed: true, bottomConfirmed: true });
  expect(visited.has(0)).toBe(true);
  expect(visited.has(4)).toBe(true);
  expect(scroller.scrollTop).toBe(800);
});

it('waits through delayed prepending and its scroll anchoring', async () => {
  const { options, scroller } = fixture();
  let pauses = 0;
  const originalPause = options.pause!;
  options.pause = async ms => { await originalPause(ms); if (++pauses === 3) { scroller.scrollHeight += 600; scroller.scrollTop = 600; } };
  options.observe = () => ({ keys: [`turn-${Math.floor(scroller.scrollTop / 100)}`], pending: pauses < 3 });
  const result = await walkTimeline(options);
  expect(result).toMatchObject({ reason: 'end', topConfirmed: true, bottomConfirmed: true });
  expect(scroller.scrollTop).toBe(1400);
});

it('does not scroll again after cancellation during a wait', async () => {
  const { options, scroller } = fixture();
  let valid = true;
  options.valid = () => valid;
  options.pause = async () => { valid = false; scroller.scrollTop = 75; };
  expect(await walkTimeline(options)).toMatchObject({ reason: 'cancelled', topConfirmed: false, bottomConfirmed: false });
  expect(scroller.scrollTop).toBe(75);
});

it('stops immediately on an exact identity match', async () => {
  const { options, scroller } = fixture({ observe: () => ({ keys: ['target'], found: true }) });
  expect(await walkTimeline(options)).toMatchObject({ reason: 'found', samples: 1 });
  expect(scroller.scrollTop).toBe(800);
});

it('reports limits and never verifies empty or pending timelines', async () => {
  for (const observation of [{ keys: [] }, { keys: ['turn'], pending: true }]) {
    const { options } = fixture({ observe: () => observation, maxMs: 100 });
    expect(await walkTimeline(options)).toMatchObject({ reason: 'limit', topConfirmed: false, bottomConfirmed: false });
  }
  const { options } = fixture({ maxSteps: 1 });
  expect(await walkTimeline(options)).toMatchObject({ reason: 'limit', samples: 1 });
});

it('invalidates coverage if an anchored prepend occurs during the downward sweep', async () => {
  const { options, scroller } = fixture();
  const originalPause = options.pause!;
  options.pause = async ms => { await originalPause(ms); if (scroller.scrollTop > 0 && scroller.scrollTop < 800) { scroller.scrollHeight += 500; scroller.scrollTop += 500; } };
  expect(await walkTimeline(options)).toMatchObject({ reason: 'limit', topConfirmed: false, bottomConfirmed: false });
});
