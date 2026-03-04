/**
 * minimax.ts — Game tree search with Nash equilibrium
 *
 * Each node in the tree represents a battle state. At simultaneous-move nodes
 * (both players choose), we build a payoff matrix M[p1_choices][p2_choices],
 * solve Nash to get mixed strategies and game value. At force-switch nodes
 * (single player), we do standard minimax.
 *
 * Default depth: 3 turns. Each "turn" = one pair of choices.
 *
 * The search uses cloneBattle + makeChoices for state transitions (actual sim),
 * and evaluate() for leaf/horizon nodes.
 *
 * Output: DensePlan with mixed strategy, top move sequences, and conditional
 * branches per opponent response.
 */

import type {
	Battle, NashResult, StrategyEntry, DensePlan, TurnPlan, ConditionalBranch,
	ShadowTeam, Choice,
} from './types';
import {
	cloneBattle, getChoices, makeChoices, isTerminal, getWinValue, getCurrentTurn,
} from './state';
import { evaluate } from './eval';
import { solveNash, type GameMatrix } from './nash';

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_DEPTH = 3;

/** Max branching factor per side before pruning inferior choices */
const MAX_CHOICES_PER_SIDE = 8;

/** Threshold below which a strategy probability is considered negligible */
const STRATEGY_EPSILON = 0.01;

// ─── Types ──────────────────────────────────────────────────────

export interface SearchOptions {
	depth?: number;
	shadow?: ShadowTeam;
	/** Which player we are (0 = P1, 1 = P2). Default 0. */
	playerIndex?: number;
	/** Optional time limit in milliseconds */
	timeLimit?: number;
}

export interface SearchResult {
	/** Nash equilibrium at the root */
	nash: NashResult;
	/** Game value from our player's perspective */
	gameValue: number;
	/** Top move sequences (best lines through the tree) */
	topLines: TurnPlan[][];
	/** Conditional plans: "if opponent does X, we respond Y" */
	conditionalPlans: ConditionalBranch[];
	/** Root battle turn number */
	turn: number;
	/** Stats for debugging */
	nodesVisited: number;
}

// ─── Internal tracking ──────────────────────────────────────────

let nodesVisited = 0;
let startTime = 0;
let timeLimitMs = 0;

function isTimeUp(): boolean {
	if (timeLimitMs <= 0) return false;
	return Date.now() - startTime > timeLimitMs;
}

// ─── Main Search ────────────────────────────────────────────────

/**
 * Run minimax search with Nash equilibrium at simultaneous-move nodes.
 *
 * @param battle - The current battle state (not mutated)
 * @param options - Search configuration
 * @returns SearchResult with Nash strategy, game value, and lines
 */
export function search(battle: Battle, options: SearchOptions = {}): SearchResult {
	const depth = options.depth ?? DEFAULT_DEPTH;
	const shadow = options.shadow;
	const playerIndex = options.playerIndex ?? 0;

	nodesVisited = 0;
	startTime = Date.now();
	timeLimitMs = options.timeLimit ?? 0;

	const turn = getCurrentTurn(battle);

	// Get choices for both sides
	const p1Choices = getChoices(battle, 0);
	const p2Choices = getChoices(battle, 1);

	// Handle force-switch (single player node)
	if (p1Choices.length > 0 && p2Choices.length === 0) {
		// Only P1 chooses (P2 is waiting/forced)
		return searchSinglePlayer(battle, p1Choices, 0, depth, shadow, playerIndex, turn);
	}
	if (p2Choices.length > 0 && p1Choices.length === 0) {
		// Only P2 chooses
		return searchSinglePlayer(battle, p2Choices, 1, depth, shadow, playerIndex, turn);
	}

	if (p1Choices.length === 0 && p2Choices.length === 0) {
		// No choices for either side — evaluate terminal/leaf
		const val = evaluateNode(battle, shadow, playerIndex);
		return {
			nash: { p1Strategy: [], p2Strategy: [], gameValue: val },
			gameValue: val,
			topLines: [],
			conditionalPlans: [],
			turn,
			nodesVisited: 1,
		};
	}

	// Trim choice lists if too large (keep best options heuristically)
	const trimmedP1 = trimChoices(battle, p1Choices, 0, shadow, MAX_CHOICES_PER_SIDE);
	const trimmedP2 = trimChoices(battle, p2Choices, 1, shadow, MAX_CHOICES_PER_SIDE);

	// Build payoff matrix
	const matrix = buildPayoffMatrix(battle, trimmedP1, trimmedP2, depth - 1, shadow, playerIndex);

	// Solve Nash equilibrium
	const nash = solveNash(matrix);

	// Adjust game value for player perspective
	const gameValue = playerIndex === 0 ? nash.gameValue : -nash.gameValue;

	// Extract top lines (trace through the tree for top strategies)
	const topLines = extractTopLines(battle, trimmedP1, trimmedP2, nash, depth - 1, shadow, playerIndex);

	// Extract conditional plans
	const conditionalPlans = extractConditionalPlans(
		battle, trimmedP1, trimmedP2, nash, depth - 1, shadow, playerIndex
	);

	return {
		nash,
		gameValue,
		topLines,
		conditionalPlans,
		turn,
		nodesVisited,
	};
}

// ─── Payoff Matrix Construction ──────────────────────────────────

/**
 * Build the payoff matrix for a simultaneous-move node.
 * M[i][j] = value of position after P1 plays choice i and P2 plays choice j,
 * evaluated from P1's perspective (standard convention for Nash solver).
 */
function buildPayoffMatrix(
	battle: Battle,
	p1Choices: Choice[],
	p2Choices: Choice[],
	remainingDepth: number,
	shadow: ShadowTeam | undefined,
	playerIndex: number,
): GameMatrix {
	const payoffs: number[][] = [];

	for (let i = 0; i < p1Choices.length; i++) {
		payoffs[i] = [];
		for (let j = 0; j < p2Choices.length; j++) {
			if (isTimeUp()) {
				// If time is up, use static eval for remaining cells
				payoffs[i][j] = evaluateNode(battle, shadow, 0);
				continue;
			}

			const child = cloneBattle(battle);
			try {
				makeChoices(child, p1Choices[i].choiceString, p2Choices[j].choiceString);
			} catch {
				// Invalid choice combination — use current eval
				payoffs[i][j] = evaluateNode(battle, shadow, 0);
				continue;
			}

			// Recursively evaluate the resulting position
			payoffs[i][j] = minimaxValue(child, remainingDepth, shadow, 0);
		}
	}

	return {
		payoffs,
		p1Labels: p1Choices.map(c => c.label),
		p2Labels: p2Choices.map(c => c.label),
		p1Choices: p1Choices.map(c => c.choiceString),
		p2Choices: p2Choices.map(c => c.choiceString),
	};
}

// ─── Recursive Minimax Value ─────────────────────────────────────

/**
 * Recursively compute the value of a battle state.
 * At simultaneous-move nodes: build payoff matrix, solve Nash, return game value.
 * At single-player nodes: standard minimax.
 * At leaves/terminals: static evaluation.
 *
 * Always returns value from P1's perspective (Nash convention).
 */
function minimaxValue(
	battle: Battle,
	remainingDepth: number,
	shadow: ShadowTeam | undefined,
	_playerIndex: number,
): number {
	nodesVisited++;

	// Terminal check
	const winVal = getWinValue(battle);
	if (winVal !== null) return winVal;

	// Leaf node: static evaluation
	if (remainingDepth <= 0 || isTimeUp()) {
		return evaluateNode(battle, shadow, 0);
	}

	const p1Choices = getChoices(battle, 0);
	const p2Choices = getChoices(battle, 1);

	// No choices — evaluate as leaf
	if (p1Choices.length === 0 && p2Choices.length === 0) {
		return evaluateNode(battle, shadow, 0);
	}

	// Single-player nodes (force-switch)
	if (p1Choices.length > 0 && p2Choices.length === 0) {
		return singlePlayerMax(battle, p1Choices, remainingDepth, shadow);
	}
	if (p2Choices.length > 0 && p1Choices.length === 0) {
		return singlePlayerMin(battle, p2Choices, remainingDepth, shadow);
	}

	// Simultaneous-move node: build matrix and solve Nash
	const trimmedP1 = trimChoices(battle, p1Choices, 0, shadow, MAX_CHOICES_PER_SIDE);
	const trimmedP2 = trimChoices(battle, p2Choices, 1, shadow, MAX_CHOICES_PER_SIDE);

	const matrix = buildPayoffMatrix(battle, trimmedP1, trimmedP2, remainingDepth - 1, shadow, 0);
	const nash = solveNash(matrix);

	return nash.gameValue;
}

/**
 * Single-player maximization (P1 force-switch or only P1 moves).
 * P1 picks the choice that maximizes value.
 */
function singlePlayerMax(
	battle: Battle,
	choices: Choice[],
	remainingDepth: number,
	shadow: ShadowTeam | undefined,
): number {
	let best = -Infinity;

	for (const choice of choices) {
		if (isTimeUp()) break;

		const child = cloneBattle(battle);
		try {
			// Single player: use 'default' for the other side
			makeChoices(child, choice.choiceString, 'default');
		} catch {
			continue;
		}

		const val = minimaxValue(child, remainingDepth - 1, shadow, 0);
		if (val > best) best = val;
	}

	return best === -Infinity ? evaluateNode(battle, shadow, 0) : best;
}

/**
 * Single-player minimization (P2 force-switch or only P2 moves).
 * P2 picks the choice that minimizes P1's value.
 */
function singlePlayerMin(
	battle: Battle,
	choices: Choice[],
	remainingDepth: number,
	shadow: ShadowTeam | undefined,
): number {
	let best = Infinity;

	for (const choice of choices) {
		if (isTimeUp()) break;

		const child = cloneBattle(battle);
		try {
			makeChoices(child, 'default', choice.choiceString);
		} catch {
			continue;
		}

		const val = minimaxValue(child, remainingDepth - 1, shadow, 0);
		if (val < best) best = val;
	}

	return best === Infinity ? evaluateNode(battle, shadow, 0) : best;
}

// ─── Single-Player Search (root-level force-switch) ──────────────

function searchSinglePlayer(
	battle: Battle,
	choices: Choice[],
	movingSide: number,
	depth: number,
	shadow: ShadowTeam | undefined,
	playerIndex: number,
	turn: number,
): SearchResult {
	let bestVal = movingSide === 0 ? -Infinity : Infinity;
	let bestChoice: Choice | null = null;
	const results: { choice: Choice; value: number }[] = [];

	for (const choice of choices) {
		if (isTimeUp()) break;

		const child = cloneBattle(battle);
		try {
			if (movingSide === 0) {
				makeChoices(child, choice.choiceString, 'default');
			} else {
				makeChoices(child, 'default', choice.choiceString);
			}
		} catch {
			continue;
		}

		const val = minimaxValue(child, depth - 1, shadow, 0);
		results.push({ choice, value: val });

		if (movingSide === 0) {
			if (val > bestVal) {
				bestVal = val;
				bestChoice = choice;
			}
		} else {
			if (val < bestVal) {
				bestVal = val;
				bestChoice = choice;
			}
		}
	}

	// Build a pure strategy result for force-switch
	const strategy: StrategyEntry[] = bestChoice ? [{
		choice: bestChoice.choiceString,
		label: bestChoice.label,
		probability: 1,
	}] : [];

	const gameValue = playerIndex === 0 ? bestVal : -bestVal;

	const topLines: TurnPlan[][] = bestChoice ? [[{
		turn,
		choice: bestChoice.choiceString,
		moveName: bestChoice.label,
		evaluation: gameValue,
	}]] : [];

	return {
		nash: {
			p1Strategy: movingSide === 0 ? strategy : [],
			p2Strategy: movingSide === 1 ? strategy : [],
			gameValue: bestVal,
		},
		gameValue,
		topLines,
		conditionalPlans: [],
		turn,
		nodesVisited,
	};
}

// ─── Choice Trimming ─────────────────────────────────────────────

/**
 * Trim a choice list to at most maxChoices, keeping the most promising ones.
 * For moves: sort by heuristic damage. For switches: keep all (usually few).
 * Always keep at least one choice.
 */
function trimChoices(
	battle: Battle,
	choices: Choice[],
	sideIndex: number,
	_shadow: ShadowTeam | undefined,
	maxChoices: number,
): Choice[] {
	if (choices.length <= maxChoices) return choices;

	// Separate moves and switches
	const moves = choices.filter(c => c.type === 'move');
	const switches = choices.filter(c => c.type === 'switch');

	// For moves: use quick static eval to rank
	// (Simple heuristic: non-tera moves before tera, keep variety)
	const nonTeraMoves = moves.filter(c => !c.terastallize);
	const teraMoves = moves.filter(c => c.terastallize);

	// Prioritize: all non-tera moves, best tera move, then switches
	const ranked: Choice[] = [];
	ranked.push(...nonTeraMoves);

	// Add best tera move (first one, usually same ordering as non-tera)
	if (teraMoves.length > 0) {
		ranked.push(teraMoves[0]);
	}

	// Add switches
	ranked.push(...switches);

	return ranked.slice(0, maxChoices);
}

// ─── Leaf Evaluation ─────────────────────────────────────────────

/**
 * Evaluate a leaf/horizon node. Returns value from P1's perspective.
 * Wraps evaluate() which always returns P1 perspective.
 */
function evaluateNode(
	battle: Battle,
	shadow: ShadowTeam | undefined,
	_perspectiveP1: number,
): number {
	return evaluate(battle, shadow);
}

// ─── Line Extraction ─────────────────────────────────────────────

/**
 * Extract top move sequences through the tree by following the most
 * probable strategies at each node.
 *
 * Returns up to 3 top lines (sequences of TurnPlan).
 */
function extractTopLines(
	battle: Battle,
	p1Choices: Choice[],
	p2Choices: Choice[],
	nash: NashResult,
	remainingDepth: number,
	shadow: ShadowTeam | undefined,
	playerIndex: number,
): TurnPlan[][] {
	const turn = getCurrentTurn(battle);
	const lines: TurnPlan[][] = [];

	// Get top P1 strategies (sorted by probability)
	const topP1 = nash.p1Strategy
		.filter(s => s.probability >= STRATEGY_EPSILON)
		.sort((a, b) => b.probability - a.probability)
		.slice(0, 3);

	// For each top P1 strategy, find the best P2 response and trace forward
	for (const p1Strat of topP1) {
		const line: TurnPlan[] = [{
			turn,
			choice: p1Strat.choice,
			moveName: p1Strat.label,
			evaluation: playerIndex === 0 ? nash.gameValue : -nash.gameValue,
		}];

		// Find best P2 response to this P1 choice
		const p1ChoiceIdx = p1Choices.findIndex(c => c.choiceString === p1Strat.choice);
		if (p1ChoiceIdx < 0) {
			lines.push(line);
			continue;
		}

		// P2's best response: pick the column that minimizes payoff when P1 plays this row
		const p2Best = findBestP2Response(p1Choices, p2Choices, p1ChoiceIdx, battle, remainingDepth, shadow);

		if (p2Best && remainingDepth > 0) {
			// Simulate this choice pair and trace forward
			const child = cloneBattle(battle);
			try {
				makeChoices(child, p1Strat.choice, p2Best.choiceString);

				if (!isTerminal(child) && remainingDepth > 0) {
					// Recurse to get continuation
					const continuation = traceBestLine(child, remainingDepth, shadow, playerIndex);
					line.push(...continuation);
				}
			} catch {
				// Skip if invalid
			}
		}

		lines.push(line);
	}

	return lines;
}

/**
 * Find P2's best response (column that minimizes P1 payoff) for a given P1 row choice.
 */
function findBestP2Response(
	_p1Choices: Choice[],
	p2Choices: Choice[],
	_p1RowIdx: number,
	battle: Battle,
	_remainingDepth: number,
	shadow: ShadowTeam | undefined,
): Choice | null {
	if (p2Choices.length === 0) return null;

	// Quick heuristic: evaluate each P2 choice against the battle
	// (full matrix re-solve is too expensive here)
	let bestChoice: Choice | null = null;
	let bestVal = Infinity; // P2 wants to minimize P1's value

	for (const choice of p2Choices) {
		const child = cloneBattle(battle);
		try {
			makeChoices(child, 'default', choice.choiceString);
			const val = evaluateNode(child, shadow, 0);
			if (val < bestVal) {
				bestVal = val;
				bestChoice = choice;
			}
		} catch {
			continue;
		}
	}

	return bestChoice;
}

/**
 * Trace the best line forward from a position (greedy: pick highest-eval move).
 */
function traceBestLine(
	battle: Battle,
	remainingDepth: number,
	shadow: ShadowTeam | undefined,
	playerIndex: number,
): TurnPlan[] {
	const plans: TurnPlan[] = [];

	let current = battle;
	let depthLeft = remainingDepth;

	while (depthLeft > 0 && !isTerminal(current)) {
		const turn = getCurrentTurn(current);
		const p1Choices = getChoices(current, 0);
		const p2Choices = getChoices(current, 1);

		if (p1Choices.length === 0 && p2Choices.length === 0) break;

		// Find the best P1 move by static eval
		let bestChoice: Choice | null = null;
		let bestVal = -Infinity;

		const myChoices = playerIndex === 0 ? p1Choices : p2Choices;
		for (const choice of myChoices) {
			const child = cloneBattle(current);
			try {
				if (playerIndex === 0) {
					makeChoices(child, choice.choiceString, 'default');
				} else {
					makeChoices(child, 'default', choice.choiceString);
				}
				const val = evaluateNode(child, shadow, 0);
				const perspectiveVal = playerIndex === 0 ? val : -val;
				if (perspectiveVal > bestVal) {
					bestVal = perspectiveVal;
					bestChoice = choice;
				}
			} catch {
				continue;
			}
		}

		if (!bestChoice) break;

		plans.push({
			turn,
			choice: bestChoice.choiceString,
			moveName: bestChoice.label,
			evaluation: bestVal,
		});

		// Advance the battle
		const next = cloneBattle(current);
		try {
			if (playerIndex === 0) {
				makeChoices(next, bestChoice.choiceString, 'default');
			} else {
				makeChoices(next, 'default', bestChoice.choiceString);
			}
			current = next;
			depthLeft--;
		} catch {
			break;
		}
	}

	return plans;
}

// ─── Conditional Plan Extraction ─────────────────────────────────

/**
 * Extract conditional plans: "if opponent does X, our best response is Y".
 *
 * For each probable opponent action, find our best response.
 */
function extractConditionalPlans(
	battle: Battle,
	p1Choices: Choice[],
	p2Choices: Choice[],
	nash: NashResult,
	remainingDepth: number,
	shadow: ShadowTeam | undefined,
	playerIndex: number,
): ConditionalBranch[] {
	const turn = getCurrentTurn(battle);
	const branches: ConditionalBranch[] = [];

	// From P1's perspective: for each possible P2 action
	const opponentChoices = playerIndex === 0 ? p2Choices : p1Choices;
	const ourChoices = playerIndex === 0 ? p1Choices : p2Choices;

	// Consider top opponent moves. If Nash is pure, also include all opponent choices
	// so the user can see conditional responses to non-equilibrium opponent plays.
	const opponentStrats = playerIndex === 0 ? nash.p2Strategy : nash.p1Strategy;
	const nashOpponent = opponentStrats
		.filter(s => s.probability >= STRATEGY_EPSILON)
		.sort((a, b) => b.probability - a.probability);

	// Build a list of opponent strategies to consider: Nash strategies + remaining moves
	const seenChoices = new Set(nashOpponent.map(s => s.choice));
	const extraOpponent: StrategyEntry[] = opponentChoices
		.filter(c => !seenChoices.has(c.choiceString) && c.type === 'move')
		.slice(0, 4)
		.map(c => ({ choice: c.choiceString, label: c.label, probability: 0 }));

	const topOpponent = [...nashOpponent, ...extraOpponent].slice(0, 5);

	for (const oppStrat of topOpponent) {
		// Find our best response to this opponent move
		let bestChoice: Choice | null = null;
		let bestVal = -Infinity;

		for (const ourChoice of ourChoices) {
			const child = cloneBattle(battle);
			try {
				if (playerIndex === 0) {
					makeChoices(child, ourChoice.choiceString, oppStrat.choice);
				} else {
					makeChoices(child, oppStrat.choice, ourChoice.choiceString);
				}

				const val = minimaxValue(child, Math.min(remainingDepth - 1, 1), shadow, 0);
				const perspectiveVal = playerIndex === 0 ? val : -val;

				if (perspectiveVal > bestVal) {
					bestVal = perspectiveVal;
					bestChoice = ourChoice;
				}
			} catch (_e) {
				// Choice combination invalid, skip
				continue;
			}
		}

		if (bestChoice) {
			branches.push({
				opponentMove: oppStrat.label,
				response: {
					turn,
					choice: bestChoice.choiceString,
					moveName: bestChoice.label,
					evaluation: bestVal,
				},
				evaluation: bestVal,
			});
		}
	}

	return branches;
}

// ─── Dense Plan Builder ──────────────────────────────────────────

/**
 * Build a complete DensePlan from a search result.
 * This is the primary output format for the CLI.
 */
export function buildDensePlan(
	result: SearchResult,
	shadowSummary?: any,
): DensePlan {
	return {
		turn: result.turn,
		mixedStrategy: result.nash.p1Strategy,
		gameValue: result.gameValue,
		topLines: result.topLines,
		conditionalPlans: result.conditionalPlans,
		shadowTeamSummary: shadowSummary,
	};
}

// ─── Dense Plan Formatting ───────────────────────────────────────

/**
 * Format a DensePlan into a human-readable string for CLI output.
 */
export function formatDensePlan(
	plan: DensePlan,
	p1Active: string,
	p2Active: string,
): string {
	const lines: string[] = [];

	lines.push(`=== ${p1Active} vs ${p2Active} (Turn ${plan.turn}) ===`);
	lines.push('');

	// Shadow Team Intelligence
	if (plan.shadowTeamSummary) {
		const s = plan.shadowTeamSummary;
		lines.push('Shadow Team Intelligence:');
		if (s.slotsRemaining > 0) {
			lines.push(`  Unrevealed slots: ${s.slotsRemaining}`);
		}
		if (s.topCandidates?.length > 0) {
			const top = s.topCandidates.slice(0, 5).map(
				(c: any) => `${c.species} (${(c.probability * 100).toFixed(1)}%, ${c.types.join('/')})`
			).join(', ');
			lines.push(`  Top candidates: ${top}`);
		}
		if (s.threats?.length > 0) {
			const threats = s.threats.slice(0, 3).map(
				(t: any) => `${t.species} (${t.reason})`
			).join(', ');
			lines.push(`  Threats: ${threats}`);
		}
		if (s.absences?.length > 0) {
			lines.push(`  Notable absences: ${s.absences.join(', ')}`);
		}
		lines.push('');
	}

	// Nash Equilibrium
	lines.push('Nash Equilibrium: ← RECOMMENDED');
	for (const strat of plan.mixedStrategy) {
		const pct = (strat.probability * 100).toFixed(1);
		lines.push(`  ${strat.label}: ${pct}%`);
	}
	lines.push('');

	// Game Value
	const sign = plan.gameValue >= 0 ? '+' : '';
	lines.push(`Game Value: ${sign}${plan.gameValue.toFixed(3)}`);
	lines.push('');

	// 3-Turn Plan
	if (plan.topLines.length > 0) {
		lines.push('3-Turn Plan:');
		for (let i = 0; i < plan.topLines.length; i++) {
			const line = plan.topLines[i];
			const moves = line.map(p => `${p.moveName} (${p.evaluation >= 0 ? '+' : ''}${p.evaluation.toFixed(2)})`).join(' → ');
			lines.push(`  Line ${i + 1}: ${moves}`);
		}
		lines.push('');
	}

	// Conditional Plans
	if (plan.conditionalPlans.length > 0) {
		lines.push('Awaiting Opponent Response:');
		for (const branch of plan.conditionalPlans) {
			const sign = branch.evaluation >= 0 ? '+' : '';
			lines.push(`  If ${branch.opponentMove} → ${branch.response.moveName} (${sign}${branch.evaluation.toFixed(2)})`);
		}
		lines.push('');
	}

	return lines.join('\n');
}
