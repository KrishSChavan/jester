import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitRidge, predictRidge } from '../jester-extension/src/common/ridge.js';

/** A small seeded generator, so a failure reproduces. */
function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

test('recovers an exact linear map, intercept included, with a negligible penalty', () => {
  const r = rng(7);
  const rows = [];
  const targets = [];
  for (let i = 0; i < 60; i += 1) {
    const a = gauss(r) * 3;
    const b = gauss(r) * 0.01; // wildly different scales: standardising must cope
    const c = gauss(r) * 100;
    rows.push([a, b, c]);
    targets.push([5 + 2 * a - 300 * b + 0.05 * c, -1 + 0.5 * a]);
  }
  const fit = fitRidge(rows, targets, { lambda: 1e-10 });
  assert.ok(fit);
  for (let i = 0; i < rows.length; i += 1) {
    const [x, y] = predictRidge(fit, rows[i]);
    assert.ok(Math.abs(x - targets[i][0]) < 1e-6, `x ${x} vs ${targets[i][0]}`);
    assert.ok(Math.abs(y - targets[i][1]) < 1e-6, `y ${y} vs ${targets[i][1]}`);
  }
});

test('a constant column neither breaks the solve nor moves the answer', () => {
  const rows = [];
  const targets = [];
  for (let i = 0; i < 20; i += 1) {
    rows.push([i, 42]);
    targets.push([3 * i + 1]);
  }
  const fit = fitRidge(rows, targets, { lambda: 1e-10 });
  assert.ok(fit);
  assert.ok(Math.abs(predictRidge(fit, [7, 42])[0] - 22) < 1e-6);
  assert.equal(fit.scale[1], 1);
});

test('integer weights act exactly like repeated rows', () => {
  const r = rng(3);
  const rows = [];
  const targets = [];
  const weights = [];
  const repeated = [];
  const repeatedTargets = [];
  for (let i = 0; i < 25; i += 1) {
    const row = [gauss(r), gauss(r), gauss(r)];
    const t = [gauss(r) + row[0], gauss(r) - row[2]];
    const w = 1 + (i % 3);
    rows.push(row);
    targets.push(t);
    weights.push(w);
    for (let k = 0; k < w; k += 1) {
      repeated.push(row);
      repeatedTargets.push(t);
    }
  }
  const a = fitRidge(rows, targets, { weights, lambda: 0.3 });
  const b = fitRidge(repeated, repeatedTargets, { lambda: 0.3 });
  const probe = [0.3, -1.2, 0.7];
  const pa = predictRidge(a, probe);
  const pb = predictRidge(b, probe);
  assert.ok(Math.abs(pa[0] - pb[0]) < 1e-9 && Math.abs(pa[1] - pb[1]) < 1e-9);
});

test('a larger penalty pulls predictions toward the mean', () => {
  const rows = [];
  const targets = [];
  for (let i = 0; i < 30; i += 1) {
    rows.push([i / 10]);
    targets.push([10 * (i / 10)]);
  }
  const loose = fitRidge(rows, targets, { lambda: 1e-8 });
  const tight = fitRidge(rows, targets, { lambda: 10 });
  const meanY = targets.reduce((s, t) => s + t[0], 0) / targets.length;
  const far = [10];
  assert.ok(Math.abs(predictRidge(tight, far)[0] - meanY) < Math.abs(predictRidge(loose, far)[0] - meanY));
});

test('matches the closed form on random data', () => {
  const r = rng(11);
  const n = 40;
  const p = 5;
  const rows = Array.from({ length: n }, () => Array.from({ length: p }, () => gauss(r)));
  const targets = rows.map((row) => [row.reduce((s, v, j) => s + v * (j + 1), 0) + gauss(r) * 0.5]);
  const lambda = 0.05;
  const fit = fitRidge(rows, targets, { lambda });
  // Closed form by Gaussian elimination, on the same standardisation.
  const Z = rows.map((row) => row.map((v, j) => (v - fit.mean[j]) / fit.scale[j]));
  const ybar = targets.reduce((s, t) => s + t[0], 0) / n;
  const A = Array.from({ length: p }, (_, a) =>
    Array.from({ length: p }, (_, b) => Z.reduce((s, z) => s + z[a] * z[b], 0) + (a === b ? lambda * n : 0))
  );
  const B = Array.from({ length: p }, (_, a) => Z.reduce((s, z, i) => s + z[a] * (targets[i][0] - ybar), 0));
  for (let c = 0; c < p; c += 1) {
    let piv = c;
    for (let i = c + 1; i < p; i += 1) if (Math.abs(A[i][c]) > Math.abs(A[piv][c])) piv = i;
    [A[c], A[piv]] = [A[piv], A[c]];
    [B[c], B[piv]] = [B[piv], B[c]];
    for (let i = c + 1; i < p; i += 1) {
      const f = A[i][c] / A[c][c];
      for (let j = c; j < p; j += 1) A[i][j] -= f * A[c][j];
      B[i] -= f * B[c];
    }
  }
  const beta = new Array(p);
  for (let i = p - 1; i >= 0; i -= 1) {
    let s = B[i];
    for (let j = i + 1; j < p; j += 1) s -= A[i][j] * beta[j];
    beta[i] = s / A[i][i];
  }
  for (let j = 0; j < p; j += 1) assert.ok(Math.abs(beta[j] - fit.coef[0][j]) < 1e-9);
  assert.ok(Math.abs(fit.intercept[0] - ybar) < 1e-12);
});

test('refuses what it cannot fit', () => {
  assert.equal(fitRidge([], []), null);
  assert.equal(fitRidge([[1]], [[1], [2]]), null);
  assert.equal(fitRidge([[1], [2]], [[1], [2]], { weights: [0, 0] }), null);
  assert.equal(fitRidge([[NaN], [2]], [[1], [2]], { lambda: 1 }), null);
});
