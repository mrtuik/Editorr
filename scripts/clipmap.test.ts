import * as m from '../src/core/clipmap.ts';
import assert from 'node:assert/strict';
const c = { id: 'a', startMs: 2000, lenMs: 4000, durationMs: 10000, srcMs: 1000, speed: 1 };
assert.equal(m.fileTimeAt(c, 2000), 1000);
assert.equal(m.fileTimeAt(c, 3500), 2500);
assert.equal(m.fileTimeAt(c, 6000), null);
// speed 2: consumes 2 file-seconds per timeline second
const f = { ...c, speed: 2 };
assert.equal(m.fileTimeAt(f, 3000), 3000);
assert.equal(m.maxLenMs(f), 4500);
// split is source-continuous
const [h, t] = m.splitClip(c, 4000)!;
assert.equal(h.lenMs, 2000); assert.equal(t.startMs, 4000); assert.equal(t.srcMs, 3000); assert.equal(t.lenMs, 2000);
assert.equal(m.fileTimeAt(h, 3999)! + 1, m.fileTimeAt(t, 4000));
assert.equal(m.splitClip(c, 2050), null);
// head trim keeps remaining frames in place (file time at a fixed timeline time is unchanged)
const before = m.fileTimeAt(c, 4000);
const th = m.trimEdge(c, 'head', 3000);
assert.equal(m.fileTimeAt(th, 4000), before); assert.equal(th.startMs, 3000); assert.equal(th.srcMs, 2000); assert.equal(th.lenMs, 3000);
// head trim cannot reveal beyond file start; start 2000, src 1000 -> earliest 1000
assert.equal(m.trimEdge(c, 'head', 0).startMs, 1000);
assert.equal(m.trimEdge(c, 'head', 0).srcMs, 0);
// head trim with speed
const hf = m.trimEdge(f, 'head', 3000); assert.equal(hf.srcMs, 3000); assert.equal(m.fileTimeAt(hf, 4000), m.fileTimeAt(f, 4000));
// tail limited by file end and min length
assert.equal(m.trimEdge(c, 'tail', 99999).lenMs, 9000);
assert.equal(m.trimEdge(c, 'tail', 0).lenMs, 100);
assert.equal(m.trimEdge(c, 'head', 99999).lenMs, 100);
// fades
assert.equal(m.fadeFactor(c, 2000, 500, 0), 0); assert.equal(m.fadeFactor(c, 2250, 500, 0), 0.5); assert.equal(m.fadeFactor(c, 4000, 500, 500), 1);
// snap + ruler + lanes
assert.equal(m.snapTo(1990, [0, 2000], 20), 2000); assert.equal(m.snapTo(1900, [0, 2000], 20), null);
assert.equal(m.rulerStep(50), 1); assert.equal(m.rulerStep(300), 1/6);
assert.deepEqual(m.assignLanes([[0, 1000], [500, 1500], [1000, 2000]]).line, [0, 1, 0]);
console.log('clipmap OK');
