import { describe, expect, it } from 'vitest';
import { progressOf } from './progress.js';

describe('demand progress stages', () => {
  it('separates handed off, PO preparation and simulated POs from awarded', () => {
    // D-000451: half on a simulated PO, half handed off to the PO team.
    expect(progressOf([{ ExecState: 'PO_CREATED', Sim: 1, Q: '5880000' }, { ExecState: 'HANDED_OFF', Sim: 0, Q: '5880000' }]))
      .toMatchObject({ onPoSimulated: 50, handedOff: 50, onPo: 0, awarded: 0 });
    // D-000452: PO preparation and handed off.
    expect(progressOf([{ ExecState: 'PO_PREPARATION', Q: '5880000' }, { ExecState: 'HANDED_OFF', Q: '4704000' }]))
      .toMatchObject({ poPrep: 55.6, handedOff: 44.4, awarded: 0 });
  });

  it('keeps real POs, quotes and merged-out quantity apart', () => {
    const p = progressOf([{ ExecState: 'PO_SUBMITTED', Sim: 0, Q: '1000' }, { ExecState: 'QUOTED', Q: '1000' }, { ExecState: 'MERGED_OUT', Q: '5000' }])!;
    expect(p).toMatchObject({ onPo: 50, quoted: 50, inRfq: 0, onPoSimulated: 0 });
    expect(progressOf([])).toBeNull();
  });
});
