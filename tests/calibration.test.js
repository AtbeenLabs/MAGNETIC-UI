import test from 'node:test';
import assert from 'node:assert/strict';
import {
  averageVector,
  subtractVectors,
  vectorMagnitude,
  fitDirectionMapping,
  applyDirectionMapping,
} from '../src/calibration.js';

test('averageVector averages the three sensor axes', () => {
  const result = averageVector([
    { x: 1, y: 3, z: 5 },
    { x: 3, y: 5, z: 7 },
  ]);
  assert.deepEqual(result, { x: 2, y: 4, z: 6 });
});

test('subtractVectors and vectorMagnitude calculate a baseline delta', () => {
  const delta = subtractVectors({ x: 4, y: 8, z: 3 }, { x: 1, y: 2, z: 3 });
  assert.deepEqual(delta, { x: 3, y: 6, z: 0 });
  assert.equal(vectorMagnitude(delta), Math.sqrt(45));
});

test('four point mapping maps field deltas to the expected screen quadrants', () => {
  const matrix = fitDirectionMapping({
    left: { x: -12, y: 0, z: 2 },
    right: { x: 12, y: 0, z: 2 },
    up: { x: 0, y: 12, z: 2 },
    down: { x: 0, y: -12, z: 2 },
  });
  const left = applyDirectionMapping(matrix, { x: -12, y: 0, z: 2 });
  const right = applyDirectionMapping(matrix, { x: 12, y: 0, z: 2 });
  const up = applyDirectionMapping(matrix, { x: 0, y: 12, z: 2 });
  const down = applyDirectionMapping(matrix, { x: 0, y: -12, z: 2 });
  assert.ok(left.x < -0.8 && Math.abs(left.y) < 0.2);
  assert.ok(right.x > 0.8 && Math.abs(right.y) < 0.2);
  assert.ok(up.y < -0.8 && Math.abs(up.x) < 0.2);
  assert.ok(down.y > 0.8 && Math.abs(down.x) < 0.2);
});

test('mapping rejects missing and near-zero calibration samples', () => {
  assert.throws(() => fitDirectionMapping({}), /Missing left/);
  assert.throws(() => fitDirectionMapping({
    left: { x: 0, y: 0, z: 0 },
    right: { x: 12, y: 0, z: 2 },
    up: { x: 0, y: 12, z: 2 },
    down: { x: 0, y: -12, z: 2 },
  }), /too close to the baseline/);
});
