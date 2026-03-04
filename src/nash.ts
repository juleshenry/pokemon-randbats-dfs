/**
 * nash.ts — 2-player zero-sum Nash equilibrium solver
 *
 * Solves for mixed-strategy Nash equilibria in zero-sum simultaneous-move games.
 * Uses LP formulation via javascript-lp-solver.
 *
 * For a zero-sum game with payoff matrix M (rows = P1 strategies, cols = P2 strategies):
 *   P1 maximizes their minimum expected payoff.
 *   P2 minimizes P1's maximum expected payoff.
 *
 * LP for P1 (maximin):
 *   maximize v
 *   subject to: for each P2 strategy j: sum_i(p_i * M[i][j]) >= v
 *               sum_i(p_i) = 1
 *               p_i >= 0
 *
 * LP for P2 (minimax, dual):
 *   minimize v
 *   subject to: for each P1 strategy i: sum_j(q_j * M[i][j]) <= v
 *               sum_j(q_j) = 1
 *               q_j >= 0
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Solver = require('javascript-lp-solver');

import type { NashResult, StrategyEntry } from './types';

// ─── Types ──────────────────────────────────────────────────────

export interface GameMatrix {
	/** Payoff matrix M[i][j] = payoff to P1 when P1 plays i, P2 plays j */
	payoffs: number[][];
	/** Labels for P1's strategies (row labels) */
	p1Labels: string[];
	/** Labels for P2's strategies (column labels) */
	p2Labels: string[];
	/** Choice strings for P1 (e.g., 'move 1', 'switch 3') */
	p1Choices: string[];
	/** Choice strings for P2 */
	p2Choices: string[];
}

// ─── Dominated Strategy Pruning ─────────────────────────────────

/**
 * Remove strictly dominated strategies from the game matrix.
 * A strategy is strictly dominated if there exists another strategy
 * that gives a strictly better payoff against ALL opponent strategies.
 *
 * Returns the pruned matrix and the mapping from new indices to original.
 */
export function pruneDominated(matrix: GameMatrix): {
	pruned: GameMatrix;
	p1Map: number[];
	p2Map: number[];
} {
	const m = matrix.payoffs;
	const rows = m.length;
	const cols = m[0]?.length ?? 0;

	if (rows === 0 || cols === 0) {
		return { pruned: matrix, p1Map: [], p2Map: [] };
	}

	// Iteratively remove dominated strategies (one pass each direction)
	let activeRows = Array.from({ length: rows }, (_, i) => i);
	let activeCols = Array.from({ length: cols }, (_, i) => i);

	let changed = true;
	const maxIter = rows + cols; // prevent infinite loop
	let iter = 0;

	while (changed && iter < maxIter) {
		changed = false;
		iter++;

		// Remove dominated P1 strategies (rows)
		// Row i is dominated by row k if M[k][j] > M[i][j] for all active j
		const newRows: number[] = [];
		for (const i of activeRows) {
			let isDominated = false;
			for (const k of activeRows) {
				if (k === i) continue;
				let dominates = true;
				for (const j of activeCols) {
					if (m[k][j] <= m[i][j]) {
						dominates = false;
						break;
					}
				}
				if (dominates) {
					isDominated = true;
					break;
				}
			}
			if (!isDominated) {
				newRows.push(i);
			} else {
				changed = true;
			}
		}
		activeRows = newRows;

		// Remove dominated P2 strategies (columns)
		// Column j is dominated by column l if M[i][l] < M[i][j] for all active i
		// (P2 wants to minimize P1's payoff)
		const newCols: number[] = [];
		for (const j of activeCols) {
			let isDominated = false;
			for (const l of activeCols) {
				if (l === j) continue;
				let dominates = true;
				for (const i of activeRows) {
					if (m[i][l] >= m[i][j]) {
						dominates = false;
						break;
					}
				}
				if (dominates) {
					isDominated = true;
					break;
				}
			}
			if (!isDominated) {
				newCols.push(j);
			} else {
				changed = true;
			}
		}
		activeCols = newCols;
	}

	// Build pruned matrix
	const prunedPayoffs = activeRows.map(i => activeCols.map(j => m[i][j]));
	const pruned: GameMatrix = {
		payoffs: prunedPayoffs,
		p1Labels: activeRows.map(i => matrix.p1Labels[i]),
		p2Labels: activeCols.map(j => matrix.p2Labels[j]),
		p1Choices: activeRows.map(i => matrix.p1Choices[i]),
		p2Choices: activeCols.map(j => matrix.p2Choices[j]),
	};

	return { pruned, p1Map: activeRows, p2Map: activeCols };
}

// ─── Nash Solver ─────────────────────────────────────────────────

/**
 * Solve for Nash equilibrium of a 2-player zero-sum game.
 *
 * Returns mixed strategies for both players and the game value.
 */
export function solveNash(matrix: GameMatrix): NashResult {
	const { pruned, p1Map, p2Map } = pruneDominated(matrix);
	const m = pruned.payoffs;
	const rows = m.length;
	const cols = m[0]?.length ?? 0;

	// Edge cases
	if (rows === 0 || cols === 0) {
		return { p1Strategy: [], p2Strategy: [], gameValue: 0 };
	}

	// Trivial: 1x1 game
	if (rows === 1 && cols === 1) {
		return {
			p1Strategy: [{ choice: pruned.p1Choices[0], label: pruned.p1Labels[0], probability: 1 }],
			p2Strategy: [{ choice: pruned.p2Choices[0], label: pruned.p2Labels[0], probability: 1 }],
			gameValue: m[0][0],
		};
	}

	// Trivial: 1xN (P1 has one choice) — P2 picks the column minimizing payoff
	if (rows === 1) {
		let minCol = 0;
		for (let j = 1; j < cols; j++) {
			if (m[0][j] < m[0][minCol]) minCol = j;
		}
		const p2Strat: StrategyEntry[] = pruned.p2Choices.map((c, j) => ({
			choice: c, label: pruned.p2Labels[j], probability: j === minCol ? 1 : 0,
		}));
		return {
			p1Strategy: [{ choice: pruned.p1Choices[0], label: pruned.p1Labels[0], probability: 1 }],
			p2Strategy: p2Strat.filter(s => s.probability > 0),
			gameValue: m[0][minCol],
		};
	}

	// Trivial: Nx1 (P2 has one choice) — P1 picks the row maximizing payoff
	if (cols === 1) {
		let maxRow = 0;
		for (let i = 1; i < rows; i++) {
			if (m[i][0] > m[maxRow][0]) maxRow = i;
		}
		const p1Strat: StrategyEntry[] = pruned.p1Choices.map((c, i) => ({
			choice: c, label: pruned.p1Labels[i], probability: i === maxRow ? 1 : 0,
		}));
		return {
			p1Strategy: p1Strat.filter(s => s.probability > 0),
			p2Strategy: [{ choice: pruned.p2Choices[0], label: pruned.p2Labels[0], probability: 1 }],
			gameValue: m[maxRow][0],
		};
	}

	// Check for pure strategy Nash (saddle point)
	const saddle = findSaddlePoint(m);
	if (saddle) {
		return {
			p1Strategy: [{ choice: pruned.p1Choices[saddle.row], label: pruned.p1Labels[saddle.row], probability: 1 }],
			p2Strategy: [{ choice: pruned.p2Choices[saddle.col], label: pruned.p2Labels[saddle.col], probability: 1 }],
			gameValue: saddle.value,
		};
	}

	// General case: solve via LP
	// First, shift the matrix so all values are positive (LP requires v > 0)
	const minVal = Math.min(...m.flat());
	const shift = minVal < 0 ? -minVal + 1 : 0;
	const shifted = m.map(row => row.map(v => v + shift));

	// ─── Solve for P1 (maximin) ─────────────────
	const p1Result = solveP1LP(shifted, pruned);

	// ─── Solve for P2 (minimax) ─────────────────
	const p2Result = solveP2LP(shifted, pruned);

	// Unshift the game value
	const gameValue = (p1Result.gameValue || p2Result.gameValue) - shift;

	// Map back to original indices
	const p1Strategy = buildFullStrategy(
		p1Result.strategy, pruned, p1Map, matrix.p1Choices, matrix.p1Labels, 'p1'
	);
	const p2Strategy = buildFullStrategy(
		p2Result.strategy, pruned, p2Map, matrix.p2Choices, matrix.p2Labels, 'p2'
	);

	return {
		p1Strategy: p1Strategy.filter(s => s.probability > 1e-6),
		p2Strategy: p2Strategy.filter(s => s.probability > 1e-6),
		gameValue: Math.round(gameValue * 1e6) / 1e6,
	};
}

function findSaddlePoint(m: number[][]): { row: number; col: number; value: number } | null {
	const rows = m.length;
	const cols = m[0].length;

	for (let i = 0; i < rows; i++) {
		// Find minimum in row i (P1's guarantee for this strategy)
		let rowMin = Infinity;
		for (let j = 0; j < cols; j++) {
			if (m[i][j] < rowMin) rowMin = m[i][j];
		}

		for (let j = 0; j < cols; j++) {
			if (m[i][j] !== rowMin) continue;

			// Check if this is also the column maximum (P2's best response here)
			let colMax = -Infinity;
			for (let k = 0; k < rows; k++) {
				if (m[k][j] > colMax) colMax = m[k][j];
			}

			if (rowMin === colMax) {
				return { row: i, col: j, value: rowMin };
			}
		}
	}

	return null;
}

/**
 * Solve P1's LP: maximize v subject to constraints.
 *
 * Standard form: maximize v
 *   for each col j: sum_i (p_i * M[i][j]) >= v  →  sum_i (p_i * M[i][j]) - v >= 0
 *   sum_i p_i = 1
 *   p_i >= 0
 *
 * javascript-lp-solver format uses variables contributing to constraints.
 */
function solveP1LP(m: number[][], matrix: GameMatrix): { strategy: number[]; gameValue: number } {
	const rows = m.length;
	const cols = m[0].length;

	// Variables: p_0, p_1, ..., p_{rows-1}, v
	// Constraints:
	//   For each column j: sum_i(p_i * m[i][j]) >= v  →  sum_i(p_i * m[i][j]) - v >= 0
	//   sum_i(p_i) = 1

	const model: any = {
		optimize: 'gameValue',
		opType: 'max',
		constraints: {} as Record<string, any>,
		variables: {} as Record<string, any>,
	};

	// Column constraints: for each j, sum_i(p_i * M[i][j]) - v >= 0
	for (let j = 0; j < cols; j++) {
		model.constraints[`col_${j}`] = { min: 0 };
	}
	// Probability sum = 1
	model.constraints['prob_sum'] = { equal: 1 };

	// P1 probability variables
	for (let i = 0; i < rows; i++) {
		const varObj: any = { prob_sum: 1 };
		for (let j = 0; j < cols; j++) {
			varObj[`col_${j}`] = m[i][j];
		}
		model.variables[`p${i}`] = varObj;
	}

	// Game value variable v (appears as -1 in each column constraint)
	const vObj: any = { gameValue: 1 };
	for (let j = 0; j < cols; j++) {
		vObj[`col_${j}`] = -1;
	}
	model.variables['v'] = vObj;

	const result = Solver.Solve(model);

	if (!result.feasible) {
		// Fallback: uniform strategy
		const uniform = new Array(rows).fill(1 / rows);
		return { strategy: uniform, gameValue: 0 };
	}

	const strategy = [];
	for (let i = 0; i < rows; i++) {
		strategy.push(result[`p${i}`] || 0);
	}

	return { strategy, gameValue: result.v || 0 };
}

/**
 * Solve P2's LP: minimize v subject to constraints.
 *
 * minimize v
 *   for each row i: sum_j(q_j * M[i][j]) <= v  →  v - sum_j(q_j * M[i][j]) >= 0
 *   sum_j(q_j) = 1
 *   q_j >= 0
 */
function solveP2LP(m: number[][], matrix: GameMatrix): { strategy: number[]; gameValue: number } {
	const rows = m.length;
	const cols = m[0].length;

	const model: any = {
		optimize: 'gameValue',
		opType: 'min',
		constraints: {} as Record<string, any>,
		variables: {} as Record<string, any>,
	};

	// Row constraints: for each i, v - sum_j(q_j * M[i][j]) >= 0
	for (let i = 0; i < rows; i++) {
		model.constraints[`row_${i}`] = { min: 0 };
	}
	// Probability sum = 1
	model.constraints['prob_sum'] = { equal: 1 };

	// P2 probability variables
	for (let j = 0; j < cols; j++) {
		const varObj: any = { prob_sum: 1 };
		for (let i = 0; i < rows; i++) {
			varObj[`row_${i}`] = -m[i][j];
		}
		model.variables[`q${j}`] = varObj;
	}

	// Game value variable v
	const vObj: any = { gameValue: 1 };
	for (let i = 0; i < rows; i++) {
		vObj[`row_${i}`] = 1;
	}
	model.variables['v'] = vObj;

	const result = Solver.Solve(model);

	if (!result.feasible) {
		const uniform = new Array(cols).fill(1 / cols);
		return { strategy: uniform, gameValue: 0 };
	}

	const strategy = [];
	for (let j = 0; j < cols; j++) {
		strategy.push(result[`q${j}`] || 0);
	}

	return { strategy, gameValue: result.v || 0 };
}

/**
 * Build full strategy array, mapping pruned indices back to original.
 */
function buildFullStrategy(
	prunedStrat: number[],
	pruned: GameMatrix,
	indexMap: number[],
	originalChoices: string[],
	originalLabels: string[],
	player: 'p1' | 'p2'
): StrategyEntry[] {
	const entries: StrategyEntry[] = [];
	const pChoices = player === 'p1' ? pruned.p1Choices : pruned.p2Choices;
	const pLabels = player === 'p1' ? pruned.p1Labels : pruned.p2Labels;

	for (let i = 0; i < prunedStrat.length; i++) {
		if (prunedStrat[i] > 1e-8) {
			entries.push({
				choice: pChoices[i],
				label: pLabels[i],
				probability: Math.round(prunedStrat[i] * 1e6) / 1e6,
			});
		}
	}

	return entries;
}

// ─── Utility Functions ──────────────────────────────────────────

/**
 * Create a GameMatrix from raw payoff data.
 */
export function createGameMatrix(
	payoffs: number[][],
	p1Choices: string[],
	p1Labels: string[],
	p2Choices: string[],
	p2Labels: string[]
): GameMatrix {
	return { payoffs, p1Choices, p1Labels, p2Choices, p2Labels };
}

/**
 * Get the expected payoff for given mixed strategies.
 */
export function expectedPayoff(
	matrix: GameMatrix,
	p1Probs: number[],
	p2Probs: number[]
): number {
	let total = 0;
	for (let i = 0; i < matrix.payoffs.length; i++) {
		for (let j = 0; j < matrix.payoffs[0].length; j++) {
			total += p1Probs[i] * p2Probs[j] * matrix.payoffs[i][j];
		}
	}
	return total;
}

/**
 * Verify that a solution is approximately a Nash equilibrium.
 * Returns the maximum regret (deviation gain) for either player.
 */
export function nashRegret(matrix: GameMatrix, result: NashResult): number {
	const m = matrix.payoffs;
	const rows = m.length;
	const cols = m[0]?.length ?? 0;

	if (rows === 0 || cols === 0) return 0;

	// Build probability vectors
	const p1Probs = new Array(rows).fill(0);
	const p2Probs = new Array(cols).fill(0);

	for (const entry of result.p1Strategy) {
		const idx = matrix.p1Choices.indexOf(entry.choice);
		if (idx >= 0) p1Probs[idx] = entry.probability;
	}
	for (const entry of result.p2Strategy) {
		const idx = matrix.p2Choices.indexOf(entry.choice);
		if (idx >= 0) p2Probs[idx] = entry.probability;
	}

	// Expected payoff under equilibrium
	const eqPayoff = expectedPayoff(matrix, p1Probs, p2Probs);

	// P1 regret: max over pure strategies i of (payoff from playing i vs P2's mixed) - eqPayoff
	let p1MaxRegret = 0;
	for (let i = 0; i < rows; i++) {
		let payoff = 0;
		for (let j = 0; j < cols; j++) {
			payoff += p2Probs[j] * m[i][j];
		}
		p1MaxRegret = Math.max(p1MaxRegret, payoff - eqPayoff);
	}

	// P2 regret: max over pure strategies j of (eqPayoff - payoff from playing j vs P1's mixed)
	let p2MaxRegret = 0;
	for (let j = 0; j < cols; j++) {
		let payoff = 0;
		for (let i = 0; i < rows; i++) {
			payoff += p1Probs[i] * m[i][j];
		}
		p2MaxRegret = Math.max(p2MaxRegret, eqPayoff - payoff);
	}

	return Math.max(p1MaxRegret, p2MaxRegret);
}

/**
 * Compute the best pure response for a player against the other's mixed strategy.
 */
export function bestResponse(
	matrix: GameMatrix,
	opponentProbs: number[],
	player: 'p1' | 'p2'
): { index: number; payoff: number } {
	const m = matrix.payoffs;

	if (player === 'p1') {
		// P1 picks row to maximize expected payoff vs P2's distribution
		let bestIdx = 0;
		let bestPayoff = -Infinity;
		for (let i = 0; i < m.length; i++) {
			let payoff = 0;
			for (let j = 0; j < m[0].length; j++) {
				payoff += opponentProbs[j] * m[i][j];
			}
			if (payoff > bestPayoff) {
				bestPayoff = payoff;
				bestIdx = i;
			}
		}
		return { index: bestIdx, payoff: bestPayoff };
	} else {
		// P2 picks column to minimize expected payoff vs P1's distribution
		let bestIdx = 0;
		let bestPayoff = Infinity;
		for (let j = 0; j < (m[0]?.length ?? 0); j++) {
			let payoff = 0;
			for (let i = 0; i < m.length; i++) {
				payoff += opponentProbs[i] * m[i][j];
			}
			if (payoff < bestPayoff) {
				bestPayoff = payoff;
				bestIdx = j;
			}
		}
		return { index: bestIdx, payoff: bestPayoff };
	}
}
