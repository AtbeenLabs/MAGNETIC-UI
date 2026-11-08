const STORAGE_KEY = 'magnetic-ui.calibration.v1';

export const DIRECTIONS = Object.freeze({
  left: [-1, 0],
  right: [1, 0],
  up: [0, -1],
  down: [0, 1],
});

export function averageVector(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error('No sensor samples were collected.');
  }
  const totals = { x: 0, y: 0, z: 0 };
  for (const sample of samples) {
    for (const axis of ['x', 'y', 'z']) {
      const value = Number(sample?.[axis]);
      if (!Number.isFinite(value)) throw new TypeError(`Invalid ${axis} sensor sample.`);
      totals[axis] += value;
    }
  }
  return {
    x: totals.x / samples.length,
    y: totals.y / samples.length,
    z: totals.z / samples.length,
  };
}

export function subtractVectors(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function vectorMagnitude(vector) {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function solveLinearSystem(matrix, rhs) {
  const size = rhs.length;
  const augmented = matrix.map((row, index) => [...row, rhs[index]]);

  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-12) {
      throw new Error('Calibration samples do not contain enough independent direction data.');
    }
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];

    const divisor = augmented[column][column];
    for (let j = column; j <= size; j += 1) augmented[column][j] /= divisor;

    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let j = column; j <= size; j += 1) {
        augmented[row][j] -= factor * augmented[column][j];
      }
    }
  }
  return augmented.map((row) => row[size]);
}

/**
 * Fit a ridge-regularized 3D-field -> 2D-screen mapping using four measured poses.
 * samples: { left: {x,y,z}, right: ..., up: ..., down: ... }
 */
export function fitDirectionMapping(samples) {
  const keys = Object.keys(DIRECTIONS);
  for (const key of keys) {
    if (!samples?.[key]) throw new Error(`Missing ${key} calibration sample.`);
    if (vectorMagnitude(samples[key]) < 1.2) {
      throw new Error(`The ${key} sample is too close to the baseline. Move the magnet nearer and capture again.`);
    }
  }

  const vectors = keys.map((key) => [samples[key].x, samples[key].y, samples[key].z]);
  const targets = keys.map((key) => DIRECTIONS[key]);
  const xtx = Array.from({ length: 3 }, () => [0, 0, 0]);
  const xty = Array.from({ length: 3 }, () => [0, 0]);

  for (let row = 0; row < vectors.length; row += 1) {
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) xtx[i][j] += vectors[row][i] * vectors[row][j];
      for (let axis = 0; axis < 2; axis += 1) xty[i][axis] += vectors[row][i] * targets[row][axis];
    }
  }

  // Scale regularization to the signal magnitude so near-dependent samples remain stable.
  const trace = xtx[0][0] + xtx[1][1] + xtx[2][2];
  const ridge = Math.max(trace * 1e-5, 1e-5);
  for (let i = 0; i < 3; i += 1) xtx[i][i] += ridge;

  const xCoefficients = solveLinearSystem(xtx, xty.map((row) => row[0]));
  const yCoefficients = solveLinearSystem(xtx, xty.map((row) => row[1]));
  return [xCoefficients, yCoefficients];
}

export function applyDirectionMapping(matrix, delta) {
  if (!Array.isArray(matrix) || matrix.length !== 2 || matrix.some((row) => !Array.isArray(row) || row.length !== 3)) {
    throw new TypeError('Invalid calibration matrix.');
  }
  const vector = [delta.x, delta.y, delta.z];
  const x = matrix[0].reduce((sum, weight, index) => sum + weight * vector[index], 0);
  const y = matrix[1].reduce((sum, weight, index) => sum + weight * vector[index], 0);
  const magnitude = Math.hypot(x, y);
  return magnitude > 1e-8 ? { x: x / magnitude, y: y / magnitude } : { x: 0, y: 0 };
}

export function saveCalibration(calibration) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(calibration));
    return true;
  } catch (error) {
    console.warn('Could not persist calibration:', error);
    return false;
  }
}

export function loadCalibration() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    const value = JSON.parse(stored);
    if (!value?.baseline || !value?.matrix || !Number.isFinite(value.baseline.x) || !Number.isFinite(value.baseline.y) || !Number.isFinite(value.baseline.z)) return null;
    if (!Array.isArray(value.matrix) || value.matrix.length !== 2 || value.matrix.some((row) => !Array.isArray(row) || row.length !== 3 || row.some((n) => !Number.isFinite(n)))) return null;
    return value;
  } catch (error) {
    console.warn('Saved calibration was unreadable:', error);
    return null;
  }
}

export function clearCalibration() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (error) { console.warn('Could not clear calibration:', error); }
}
