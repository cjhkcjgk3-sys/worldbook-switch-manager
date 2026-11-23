import test from 'node:test';
import assert from 'node:assert/strict';
import { clampPopupSize } from '../ui.js';

test('clampPopupSize rejects missing or non-finite inputs', () => {
    assert.equal(clampPopupSize(null, { width: 1280, height: 900 }), null);
    assert.equal(clampPopupSize(undefined, { width: 390, height: 844 }), null);
    assert.equal(clampPopupSize({ width: NaN, height: 400 }, { width: 390, height: 844 }), null);
    assert.equal(clampPopupSize({ width: 320, height: Infinity }, { width: 390, height: 844 }), null);
});

test('clampPopupSize keeps dimensions within viewport margins and minimum floor', () => {
    assert.deepEqual(clampPopupSize({ width: 120, height: 100 }, { width: 1280, height: 1000 }), { width: 280, height: 260 });
    assert.deepEqual(clampPopupSize({ width: 2000, height: 1500 }, { width: 1280, height: 1000 }), { width: 1264, height: 984 });
    assert.deepEqual(clampPopupSize({ width: 520, height: 610 }, { width: 1280, height: 1000 }), { width: 520, height: 610 });
    assert.deepEqual(clampPopupSize({ width: 390, height: 844 }, { width: 390, height: 844 }), { width: 374, height: 828 });
    assert.deepEqual(clampPopupSize({ width: 310, height: 560 }, { width: 320, height: 568 }), { width: 304, height: 552 });
    assert.deepEqual(clampPopupSize({ width: 800, height: 400 }, { width: 740, height: 360 }), { width: 724, height: 344 });
});

test('clampPopupSize resists transient Android IME tiny viewport collapse (WB-05 floor)', () => {
    assert.deepEqual(clampPopupSize({ width: 100, height: 100 }, { width: 240, height: 180 }), { width: 280, height: 260 });
    assert.deepEqual(clampPopupSize({ width: 500, height: 500 }, { width: 240, height: 180 }), { width: 284, height: 344 });
});
