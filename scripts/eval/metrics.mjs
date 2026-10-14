// @ts-check
/**
 * D144, the offline evaluation of a `decide()` model: pure metrics over a list of predictions, no I/O.
 * DEV-ONLY: nothing in the product imports this; `decide-eval.mjs` and its suite do.
 *
 * A prediction is `{ probabilities: number[], answer: number }`: the model's distribution over one
 * question's options and the index of the option a person actually chose. Every metric below is
 * about the question the bank inbox asks a model ("which account?"), and each answers one thing the
 * owner needs before a model may reach the inbox (D144 item 1):
 *
 *  - accuracy: how often the top choice is the one a person made;
 *  - ECE (expected calibration error, equal-width bins over the top probability): whether "82 %"
 *    means right about 82 % of the time. A model whose numbers lie must not show them;
 *  - Brier score: accuracy and calibration in one number (lower is better);
 *  - automation at an error budget: the largest share of lines, taken most-confident first, whose
 *    error rate stays within the budget, and the probability threshold that achieves it;
 *  - the floor: how many lines clear the inbox's 50 % floor, and how often those are right.
 */

/** @typedef {{ probabilities: number[], answer: number }} Prediction */

/** @param {number[]} ps */
export function argmax(ps) {
  let best = 0;
  for (let i = 1; i < ps.length; i += 1) if ((ps[i] ?? 0) > (ps[best] ?? 0)) best = i;
  return best;
}

/** @param {Prediction} p */
function top(p) {
  const i = argmax(p.probabilities);
  return { index: i, probability: p.probabilities[i] ?? 0, correct: i === p.answer };
}

/** @param {Prediction[]} preds */
export function accuracy(preds) {
  if (preds.length === 0) return 0;
  return preds.filter((p) => top(p).correct).length / preds.length;
}

/**
 * Expected calibration error over `bins` equal-width bins of the top probability: the weighted mean of
 * |accuracy - confidence| per bin.
 * @param {Prediction[]} preds @param {number} [bins]
 */
export function expectedCalibrationError(preds, bins = 10) {
  if (preds.length === 0) return 0;
  /** @type {{ n: number, conf: number, right: number }[]} */
  const buckets = Array.from({ length: bins }, () => ({ n: 0, conf: 0, right: 0 }));
  for (const p of preds) {
    const t = top(p);
    const b = Math.min(bins - 1, Math.floor(t.probability * bins));
    const bucket = /** @type {{ n: number, conf: number, right: number }} */ (buckets[b]);
    bucket.n += 1;
    bucket.conf += t.probability;
    bucket.right += t.correct ? 1 : 0;
  }
  let ece = 0;
  for (const b of buckets) {
    if (b.n === 0) continue;
    ece += (b.n / preds.length) * Math.abs(b.right / b.n - b.conf / b.n);
  }
  return ece;
}

/** Multi-class Brier score: the mean over predictions of sum_i (p_i - y_i)^2. @param {Prediction[]} preds */
export function brierScore(preds) {
  if (preds.length === 0) return 0;
  let sum = 0;
  for (const p of preds) {
    p.probabilities.forEach((q, i) => {
      const y = i === p.answer ? 1 : 0;
      sum += (q - y) ** 2;
    });
  }
  return sum / preds.length;
}

/**
 * The largest share of predictions, most confident first, whose error rate stays within `budget`
 * (e.g. 0.02 for "at most 2 % wrong"), and the lowest top probability inside that share.
 * @param {Prediction[]} preds @param {number} budget
 */
export function automationAtErrorBudget(preds, budget) {
  const ranked = preds.map(top).sort((a, b) => b.probability - a.probability);
  let errors = 0;
  let bestK = 0;
  let threshold = null;
  for (let k = 1; k <= ranked.length; k += 1) {
    const t = /** @type {{ index: number, probability: number, correct: boolean }} */ (ranked[k - 1]);
    if (!t.correct) errors += 1;
    // Never cut between two predictions of the same confidence: a threshold cannot separate them.
    const next = ranked[k];
    if (next !== undefined && next.probability === t.probability) continue;
    if (errors / k <= budget) {
      bestK = k;
      threshold = t.probability;
    }
  }
  return { rate: ranked.length === 0 ? 0 : bestK / ranked.length, lines: bestK, threshold };
}

/** @param {Prediction[]} preds @param {number} floor */
export function atFloor(preds, floor) {
  const cleared = preds.map(top).filter((t) => t.probability >= floor);
  return {
    coverage: preds.length === 0 ? 0 : cleared.length / preds.length,
    accuracy: cleared.length === 0 ? null : cleared.filter((t) => t.correct).length / cleared.length,
  };
}

/**
 * Every metric in one report.
 * @param {Prediction[]} preds
 * @param {{ errorBudget?: number, bins?: number, floor?: number }} [opts]
 */
export function evaluate(preds, opts = {}) {
  const errorBudget = opts.errorBudget ?? 0.02;
  const bins = opts.bins ?? 10;
  const floor = opts.floor ?? 0.5;
  return {
    n: preds.length,
    accuracy: accuracy(preds),
    ece: expectedCalibrationError(preds, bins),
    brier: brierScore(preds),
    errorBudget,
    automation: automationAtErrorBudget(preds, errorBudget),
    floor,
    atFloor: atFloor(preds, floor),
  };
}
