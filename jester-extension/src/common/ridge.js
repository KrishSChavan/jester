/**
 * Ridge regression, small and exact.
 *
 * The gaze model regresses a screen point on a couple of dozen numbers read off
 * the face — few enough that the normal equations are solved outright, every
 * time, with no iteration and nothing to converge. Pure: no DOM, no Chrome, so
 * it runs (and is tested) anywhere.
 *
 * What it does that a bare `(XᵀX + λI)⁻¹Xᵀy` doesn't:
 *
 *   - **Standardises** every input to zero mean and unit spread first, so one
 *     penalty means the same thing for an angle in radians and a ratio of eye
 *     widths, and a column that never moved can't blow up the solve.
 *   - **Fits an intercept**, unpenalised: the screen's centre is not something
 *     the penalty should pull the answer toward zero from.
 *   - **Weights rows**, so every calibration hold counts the same however many
 *     frames it happened to read.
 *   - **Scales the penalty with the data**: `lambda` is per unit of total
 *     weight, so the same value regularises a one-round fit and a three-round
 *     fit equally.
 */

/** A column whose spread is below this is treated as constant: centred, never scaled up. */
const MIN_SCALE = 1e-9;

/**
 * Fit `targets` from `rows`.
 *
 * @param rows `n` arrays of `p` numbers.
 * @param targets `n` arrays of `k` numbers — one per output (e.g. `[x, y]`).
 * @param weights optional `n` non-negative weights; equal if absent.
 * @param lambda the penalty per unit of total weight, on standardised inputs.
 * @returns `{ mean, scale, coef, intercept }` — `coef` is `k` arrays of `p`
 *   — or null when there is nothing to fit or the numbers aren't finite.
 */
export function fitRidge(rows, targets, { weights = null, lambda = 1 } = {}) {
  const n = rows?.length || 0;
  if (!n || targets?.length !== n) return null;
  const p = rows[0].length;
  const k = targets[0].length;
  if (!p || !k) return null;
  const w = weights || new Array(n).fill(1);

  let total = 0;
  for (let i = 0; i < n; i += 1) total += w[i];
  if (!(total > 0)) return null;

  // Weighted means and spreads of the inputs, and means of the outputs.
  const mean = new Array(p).fill(0);
  const outMean = new Array(k).fill(0);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < p; j += 1) mean[j] += w[i] * rows[i][j];
    for (let c = 0; c < k; c += 1) outMean[c] += w[i] * targets[i][c];
  }
  for (let j = 0; j < p; j += 1) mean[j] /= total;
  for (let c = 0; c < k; c += 1) outMean[c] /= total;
  const scale = new Array(p).fill(0);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < p; j += 1) scale[j] += w[i] * (rows[i][j] - mean[j]) ** 2;
  }
  for (let j = 0; j < p; j += 1) {
    const sd = Math.sqrt(scale[j] / total);
    scale[j] = sd > MIN_SCALE ? sd : 1;
  }

  // Normal equations on the standardised inputs: A = ZᵀWZ + λ·total·I, B = ZᵀW(y − ȳ).
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const B = Array.from({ length: k }, () => new Array(p).fill(0));
  const z = new Array(p);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < p; j += 1) z[j] = (rows[i][j] - mean[j]) / scale[j];
    for (let a = 0; a < p; a += 1) {
      const wa = w[i] * z[a];
      if (wa === 0) continue;
      for (let b = a; b < p; b += 1) A[a][b] += wa * z[b];
      for (let c = 0; c < k; c += 1) B[c][a] += wa * (targets[i][c] - outMean[c]);
    }
  }
  const ridge = Math.max(0, lambda) * total;
  for (let a = 0; a < p; a += 1) {
    A[a][a] += ridge;
    for (let b = 0; b < a; b += 1) A[a][b] = A[b][a];
  }

  const L = cholesky(A);
  if (!L) return null;
  const coef = B.map((rhs) => choleskySolve(L, rhs));
  const intercept = outMean.slice();
  const finite = (v) => Number.isFinite(v);
  if (!coef.every((row) => row.every(finite)) || !intercept.every(finite)) return null;
  return { mean, scale, coef, intercept };
}

/** The fitted outputs for one row of inputs: `k` numbers. */
export function predictRidge(fit, row) {
  const out = fit.intercept.slice();
  for (let j = 0; j < fit.mean.length; j += 1) {
    const zj = (row[j] - fit.mean[j]) / fit.scale[j];
    for (let c = 0; c < out.length; c += 1) out[c] += fit.coef[c][j] * zj;
  }
  return out;
}

/**
 * Lower-triangular L with L·Lᵀ = A, for a symmetric positive-definite A — or
 * null if A isn't (a penalty of zero on collinear inputs, say).
 */
function cholesky(A) {
  const p = A.length;
  const L = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let i = 0; i < p; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let sum = A[i][j];
      for (let m = 0; m < j; m += 1) sum -= L[i][m] * L[j][m];
      if (i === j) {
        if (!(sum > 0)) return null;
        L[i][i] = Math.sqrt(sum);
      } else {
        L[i][j] = sum / L[j][j];
      }
    }
  }
  return L;
}

/** x with L·Lᵀ·x = b. */
function choleskySolve(L, b) {
  const p = L.length;
  const y = new Array(p);
  for (let i = 0; i < p; i += 1) {
    let sum = b[i];
    for (let m = 0; m < i; m += 1) sum -= L[i][m] * y[m];
    y[i] = sum / L[i][i];
  }
  const x = new Array(p);
  for (let i = p - 1; i >= 0; i -= 1) {
    let sum = y[i];
    for (let m = i + 1; m < p; m += 1) sum -= L[m][i] * x[m];
    x[i] = sum / L[i][i];
  }
  return x;
}
