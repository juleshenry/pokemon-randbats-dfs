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
	ShadowTeam, Choice, MonState, FieldState, MoveInfo, DamageResult,
} from './types';
import {
	cloneBattle, getChoices, makeChoices, isTerminal, getWinValue, getCurrentTurn,
	extractFieldState, getActiveMon, extractSideState,
} from './state';
import { evaluate } from './eval';
import { solveNash, type GameMatrix } from './nash';
import {
	calcDamageWithCrit, getSpeedComparison, getEffectiveSpeed,
} from './damage-calc';

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
	/** Use analytical fast-path for payoff matrix instead of sim cloning.
	 *  Much faster (~100x), enables deeper search, but less accurate for
	 *  complex interactions. Default false (use sim-based). */
	useAnalytical?: boolean;
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
let analyticalMode = false;

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
	analyticalMode = options.useAnalytical ?? false;

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
 *
 * Two modes:
 * - Sim-based (default): clones battle, executes moves, recurses. Accurate but slow.
 * - Analytical (fast): uses damage calc + move-order logic. ~100x faster, enables deeper search.
 */
function buildPayoffMatrix(
	battle: Battle,
	p1Choices: Choice[],
	p2Choices: Choice[],
	remainingDepth: number,
	shadow: ShadowTeam | undefined,
	playerIndex: number,
): GameMatrix {
	// Use analytical fast-path when enabled
	if (analyticalMode) {
		return buildAnalyticalPayoffMatrix(battle, p1Choices, p2Choices, remainingDepth, shadow, playerIndex);
	}

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

// ─── Analytical Fast-Path Payoff Matrix ──────────────────────────

/**
 * Build a payoff matrix using analytical damage calculations instead of
 * sim cloning. This is ~100x faster and enables deeper search trees.
 *
 * For each cell (p1Choice, p2Choice):
 *
 * 1. MOVE vs MOVE: Determine speed → who moves first → apply pre-move
 *    status/stat effects from the faster mon → compute both sides' damage →
 *    estimate resulting HP → evaluate position.
 *
 * 2. MOVE vs SWITCH: The switching player takes a free hit. Compute damage
 *    from the attacking mon, estimate post-switch-in HP, evaluate matchup.
 *
 * 3. SWITCH vs SWITCH: Both switch. Evaluate the resulting matchup analytically
 *    (type advantage, speed comparison, TKO differential of new actives).
 *
 * 4. SWITCH vs MOVE: Mirror of MOVE vs SWITCH.
 *
 * The value is expressed from P1's perspective in [-1, 1] to match the
 * sim-based matrix format.
 */
export function buildAnalyticalPayoffMatrix(
	battle: Battle,
	p1Choices: Choice[],
	p2Choices: Choice[],
	remainingDepth: number,
	shadow: ShadowTeam | undefined,
	_playerIndex: number,
): GameMatrix {
	const payoffs: number[][] = [];

	// Extract current state once (shared across all cells)
	const field = extractFieldState(battle);
	const p1Active = getActiveMon(battle, 0);
	const p2Active = getActiveMon(battle, 1);
	const p1Side = extractSideState(battle, 0);
	const p2Side = extractSideState(battle, 1);

	// Base evaluation of the current position (used as reference point)
	const baseEval = evaluateNode(battle, shadow, 0);

	for (let i = 0; i < p1Choices.length; i++) {
		payoffs[i] = [];
		for (let j = 0; j < p2Choices.length; j++) {
			if (isTimeUp()) {
				payoffs[i][j] = baseEval;
				continue;
			}

			nodesVisited++;
			payoffs[i][j] = evaluateAnalyticalCell(
				p1Choices[i], p2Choices[j],
				p1Active, p2Active,
				p1Side, p2Side,
				field, baseEval, shadow,
			);
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

/**
 * Evaluate a single cell of the analytical payoff matrix.
 * Returns value from P1's perspective [-1, 1].
 */
export function evaluateAnalyticalCell(
	p1Choice: Choice,
	p2Choice: Choice,
	p1Active: MonState | null,
	p2Active: MonState | null,
	p1Side: MonState[],
	p2Side: MonState[],
	field: FieldState,
	baseEval: number,
	shadow: ShadowTeam | undefined,
): number {
	if (!p1Active || !p2Active) return baseEval;

	const p1IsMove = p1Choice.type === 'move';
	const p2IsMove = p2Choice.type === 'move';

	// SWITCH vs SWITCH: both switch, evaluate new matchup
	if (!p1IsMove && !p2IsMove) {
		return evaluateAnalyticalSwitchSwitch(
			p1Choice, p2Choice, p1Side, p2Side, field, baseEval, shadow,
		);
	}

	// MOVE vs SWITCH: P1 attacks, P2 switches (P1 gets free hit)
	if (p1IsMove && !p2IsMove) {
		return evaluateAnalyticalMoveSwitch(
			p1Active, p2Active, p1Choice, p2Choice,
			p1Side, p2Side, field, baseEval, shadow, true,
		);
	}

	// SWITCH vs MOVE: P2 attacks, P1 switches (P2 gets free hit)
	if (!p1IsMove && p2IsMove) {
		return evaluateAnalyticalMoveSwitch(
			p2Active, p1Active, p2Choice, p1Choice,
			p2Side, p1Side, field, baseEval, shadow, false,
		);
	}

	// MOVE vs MOVE: both attack, determine speed and move-order effects
	return evaluateAnalyticalMoveMove(
		p1Active, p2Active, p1Choice, p2Choice,
		field, baseEval, shadow,
	);
}

/**
 * Evaluate MOVE vs MOVE cell analytically.
 *
 * KEY LOGIC: Speed comparison → faster mon acts first.
 * If faster mon KOs slower mon, slower mon doesn't get to act.
 * If faster mon uses status (burn/para), it affects slower mon's damage.
 */
function evaluateAnalyticalMoveMove(
	p1Active: MonState,
	p2Active: MonState,
	p1Choice: Choice,
	p2Choice: Choice,
	field: FieldState,
	baseEval: number,
	_shadow: ShadowTeam | undefined,
): number {
	const p1Move = getMoveFromChoice(p1Active, p1Choice);
	const p2Move = getMoveFromChoice(p2Active, p2Choice);

	if (!p1Move || !p2Move) return baseEval;

	const opts = { field };

	// Determine speed
	const speedResult = getSpeedComparison(p1Active, p1Move, p2Active, p2Move, field);

	// Calculate base damage for both moves
	let p1Dmg = calcDamageWithCrit(p1Active, p2Active, p1Move, opts);
	let p2Dmg = calcDamageWithCrit(p2Active, p1Active, p2Move, opts);

	// Get raw expected damage values
	let p1ExpDmg = p1Dmg.expectedWithAccuracy;
	let p2ExpDmg = p2Dmg.expectedWithAccuracy;

	// ─── Move-order adjustments ───────────────────────────────

	if (speedResult.faster === 'p1') {
		// P1 moves first

		// If P1 OHKOs P2, P2 doesn't get to act
		if (p1ExpDmg >= p2Active.hp) {
			// P2 is KO'd before acting → massive advantage for P1
			const p2HPAfter = 0;
			return computeHPDeltaEval(
				p1Active.hp, p1Active.maxhp,
				p2HPAfter, p2Active.maxhp,
				baseEval,
			);
		}

		// If P1 uses a status move that degrades P2's damage
		p2ExpDmg = applyPreMoveStatusEffect(p1Move, p1Active, p2Active, p2Move, p2ExpDmg);
	} else if (speedResult.faster === 'p2') {
		// P2 moves first

		// If P2 OHKOs P1, P1 doesn't get to act
		if (p2ExpDmg >= p1Active.hp) {
			const p1HPAfter = 0;
			return computeHPDeltaEval(
				p1HPAfter, p1Active.maxhp,
				p2Active.hp, p2Active.maxhp,
				baseEval,
			);
		}

		// If P2 uses a status move that degrades P1's damage
		p1ExpDmg = applyPreMoveStatusEffect(p2Move, p2Active, p1Active, p1Move, p1ExpDmg);
	}
	// If tie: both move at "same time" → no adjustment (average case)

	// Compute resulting HP
	const p1HPAfter = Math.max(0, p1Active.hp - p2ExpDmg);
	const p2HPAfter = Math.max(0, p2Active.hp - p1ExpDmg);

	return computeHPDeltaEval(p1HPAfter, p1Active.maxhp, p2HPAfter, p2Active.maxhp, baseEval);
}

/**
 * Apply the effect of a faster mon's move on the slower mon's damage output.
 *
 * Returns the adjusted expected damage for the slower mon.
 *
 * Covers: Will-O-Wisp halving physical damage, Thunder Wave adding action denial,
 * Charm/Feather Dance reducing attack, etc.
 */
export function applyPreMoveStatusEffect(
	fasterMove: MoveInfo,
	fasterMon: MonState,
	slowerMon: MonState,
	slowerMove: MoveInfo,
	slowerExpDmg: number,
): number {
	// Only status moves can apply pre-move effects
	// (damaging moves with secondaries are already factored into the damage calc)
	if (fasterMove.category !== 'Status') {
		// Damaging moves with burn chance (Scald, Lava Plume) — 30% burn chance
		if (fasterMove.secondary?.status === 'brn' || fasterMove.secondaries?.some((s: any) => s.status === 'brn')) {
			if (slowerMove.category === 'Physical' && !slowerMon.status &&
				slowerMon.abilityId !== 'guts' && !slowerMon.types.includes('Fire')) {
				const burnChance = fasterMove.secondary?.chance ? fasterMove.secondary.chance / 100 : 0.3;
				// If burn lands, physical damage halved
				return slowerExpDmg * (1 - burnChance * 0.5);
			}
		}
		return slowerExpDmg;
	}

	// ─── Status moves ──────────────────────────────────────────

	// Will-O-Wisp: burns → physical damage halved
	if (fasterMove.id === 'willowisp') {
		if (slowerMove.category === 'Physical' && !slowerMon.status &&
			slowerMon.abilityId !== 'guts' && !slowerMon.types.includes('Fire')) {
			const hitRate = fasterMove.accuracy === true ? 1 : (fasterMove.accuracy as number) / 100;
			return slowerExpDmg * (1 - hitRate * 0.5);
		}
	}

	// Thunder Wave / Glare / Stun Spore / Nuzzle: para → 25% action denial
	if (fasterMove.id === 'thunderwave' || fasterMove.id === 'glare' ||
		fasterMove.id === 'stunspore' || fasterMove.id === 'nuzzle') {
		if (!slowerMon.status && slowerMon.abilityId !== 'limber') {
			// Check immunities
			if (fasterMove.id === 'thunderwave' &&
				(slowerMon.types.includes('Electric') || slowerMon.types.includes('Ground'))) {
				return slowerExpDmg;
			}
			if (fasterMove.id === 'stunspore' && slowerMon.types.includes('Grass')) {
				return slowerExpDmg;
			}
			const hitRate = fasterMove.accuracy === true ? 1 : (fasterMove.accuracy as number) / 100;
			return slowerExpDmg * (1 - hitRate * 0.25);
		}
	}

	// Spore / Sleep Powder / Hypnosis / Lovely Kiss / Dark Void: sleep → 0 damage
	if (fasterMove.id === 'spore' || fasterMove.id === 'sleeppowder' ||
		fasterMove.id === 'hypnosis' || fasterMove.id === 'lovelykiss' ||
		fasterMove.id === 'darkvoid') {
		if (!slowerMon.status) {
			// Grass immune to powder
			if ((fasterMove.id === 'spore' || fasterMove.id === 'sleeppowder') &&
				slowerMon.types.includes('Grass')) return slowerExpDmg;
			if (slowerMon.abilityId === 'insomnia' || slowerMon.abilityId === 'vitalspirit') return slowerExpDmg;
			const hitRate = fasterMove.accuracy === true ? 1 : (fasterMove.accuracy as number) / 100;
			const hasSleepTalk = slowerMon.moves.some(m => m.id === 'sleeptalk');
			return slowerExpDmg * (1 - hitRate * (hasSleepTalk ? 0.5 : 1.0));
		}
	}

	// Yawn: delayed sleep (takes effect next turn)
	if (fasterMove.id === 'yawn' && !slowerMon.status) {
		// Delayed — half-weight the sleep for this turn's damage estimate
		return slowerExpDmg * 0.75;
	}

	// Charm / Feather Dance: -2 Atk
	if (fasterMove.id === 'charm' || fasterMove.id === 'featherdance') {
		if (slowerMove.category === 'Physical' && slowerMon.abilityId !== 'contrary') {
			const hitRate = fasterMove.accuracy === true ? 1 : (fasterMove.accuracy as number) / 100;
			// -2 Atk ≈ 0.5x damage from current state (simplified)
			return slowerExpDmg * (1 - hitRate * 0.5);
		}
	}

	// Parting Shot: -1 Atk, -1 SpA
	if (fasterMove.id === 'partingshot') {
		const hitRate = fasterMove.accuracy === true ? 1 : (fasterMove.accuracy as number) / 100;
		return slowerExpDmg * (1 - hitRate * 0.33);
	}

	// Screens: Reflect halves physical, Light Screen halves special
	if (fasterMove.id === 'reflect' && slowerMove.category === 'Physical') {
		return slowerExpDmg * 0.5;
	}
	if (fasterMove.id === 'lightscreen' && slowerMove.category === 'Special') {
		return slowerExpDmg * 0.5;
	}
	if (fasterMove.id === 'auroraveil') {
		return slowerExpDmg * 0.5;
	}

	return slowerExpDmg;
}

/**
 * Evaluate MOVE vs SWITCH cell analytically.
 *
 * The attacking mon gets a free hit on the switch-in.
 * We estimate the switch-in's HP after taking the hit, then evaluate
 * the resulting matchup (attacker vs damaged switch-in).
 *
 * @param attackerIsP1 - true if P1 is attacking (and P2 is switching)
 */
function evaluateAnalyticalMoveSwitch(
	attacker: MonState,
	_currentDefender: MonState,
	moveChoice: Choice,
	switchChoice: Choice,
	attackerSide: MonState[],
	defenderSide: MonState[],
	field: FieldState,
	baseEval: number,
	_shadow: ShadowTeam | undefined,
	attackerIsP1: boolean,
): number {
	const move = getMoveFromChoice(attacker, moveChoice);
	if (!move) return baseEval;

	// Find the switch-in target
	const switchIn = defenderSide.find(m =>
		!m.fainted && !m.isActive && m.position + 1 === switchChoice.switchIndex
	);
	if (!switchIn) return baseEval;

	// The attacker's move hits the switch-in
	if (move.category === 'Status') {
		// Status move on switch-in: apply status effect value
		const statusPenalty = estimateStatusMoveValue(move, switchIn);
		return baseEval + (attackerIsP1 ? statusPenalty : -statusPenalty);
	}

	// Calculate damage to the switch-in
	const dmgResult = calcDamageWithCrit(attacker, switchIn, move, {
		field,
		defenderJustSwitched: true,
	});
	const damage = dmgResult.expectedWithAccuracy;

	// Switch-in HP after the hit
	const switchInHPAfter = Math.max(0, switchIn.hp - damage);

	if (switchInHPAfter <= 0) {
		// Switch-in is KO'd on entry → huge advantage for attacker
		// (defender loses a mon AND has to switch again)
		return attackerIsP1 ? clamp(baseEval + 0.4) : clamp(baseEval - 0.4);
	}

	// Evaluate the new matchup: attacker (full HP) vs damaged switch-in
	const hpFraction = switchInHPAfter / switchIn.maxhp;

	// The switch-in coming in damaged degrades the defender's position
	// Proportional to how much HP they lost
	const hpLostFraction = 1 - hpFraction;
	const delta = hpLostFraction * 0.2; // ~0.2 eval swing for a full HP bar of damage
	return attackerIsP1 ? clamp(baseEval + delta) : clamp(baseEval - delta);
}

/**
 * Evaluate SWITCH vs SWITCH cell analytically.
 * Both sides switch simultaneously. Evaluate the resulting matchup
 * based on the new actives' type matchup, speed, and TKO differential.
 */
function evaluateAnalyticalSwitchSwitch(
	p1Choice: Choice,
	p2Choice: Choice,
	p1Side: MonState[],
	p2Side: MonState[],
	field: FieldState,
	baseEval: number,
	_shadow: ShadowTeam | undefined,
): number {
	const p1SwitchIn = p1Side.find(m =>
		!m.fainted && !m.isActive && m.position + 1 === p1Choice.switchIndex
	);
	const p2SwitchIn = p2Side.find(m =>
		!m.fainted && !m.isActive && m.position + 1 === p2Choice.switchIndex
	);

	if (!p1SwitchIn || !p2SwitchIn) return baseEval;

	// Evaluate the new matchup using TKO differential
	const p1BestMove = findBestMoveForMatchup(p1SwitchIn, p2SwitchIn, field);
	const p2BestMove = findBestMoveForMatchup(p2SwitchIn, p1SwitchIn, field);

	const p1BestDmg = p1BestMove?.expectedWithAccuracy ?? 0;
	const p2BestDmg = p2BestMove?.expectedWithAccuracy ?? 0;

	const p1TKO = p1BestDmg > 0 ? Math.ceil(p2SwitchIn.hp / p1BestDmg) : Infinity;
	const p2TKO = p2BestDmg > 0 ? Math.ceil(p1SwitchIn.hp / p2BestDmg) : Infinity;

	if (p1TKO === Infinity && p2TKO === Infinity) return baseEval;
	if (p1TKO === Infinity) return clamp(baseEval - 0.15);
	if (p2TKO === Infinity) return clamp(baseEval + 0.15);

	const tkoAdvantage = (p2TKO - p1TKO) / 3;
	return clamp(baseEval + tkoAdvantage * 0.2);
}

/**
 * Get a MoveInfo from a Choice, looking it up in the mon's moveset.
 */
function getMoveFromChoice(mon: MonState, choice: Choice): MoveInfo | null {
	if (choice.type !== 'move' || choice.moveIndex === undefined) return null;
	return mon.moves[choice.moveIndex] ?? null;
}

/**
 * Find the best damaging move for a given attacker vs defender matchup.
 */
function findBestMoveForMatchup(
	attacker: MonState,
	defender: MonState,
	field: FieldState,
): DamageResult | null {
	let best: DamageResult | null = null;
	for (const move of attacker.moves) {
		if (move.disabled || move.category === 'Status' || move.pp <= 0) continue;
		const result = calcDamageWithCrit(attacker, defender, move, { field });
		if (!best || result.expectedWithAccuracy > best.expectedWithAccuracy) {
			best = result;
		}
	}
	return best;
}

/**
 * Estimate the value of landing a status move on a target.
 * Returns a positive value = advantage for the status user.
 */
function estimateStatusMoveValue(move: MoveInfo, target: MonState): number {
	if (target.status) return 0; // already statused

	const hitRate = move.accuracy === true ? 1 : (move.accuracy as number) / 100;

	switch (move.id) {
		case 'willowisp':
			if (target.types.includes('Fire')) return 0;
			// Burns physical attackers and adds DOT
			return hitRate * 0.12;
		case 'thunderwave':
			if (target.types.includes('Electric') || target.types.includes('Ground')) return 0;
			return hitRate * 0.10;
		case 'toxic':
			if (target.types.includes('Poison') || target.types.includes('Steel')) return 0;
			return hitRate * 0.15; // toxic is very valuable
		case 'spore':
		case 'sleeppowder':
		case 'hypnosis':
		case 'lovelykiss':
		case 'darkvoid':
			if (target.abilityId === 'insomnia' || target.abilityId === 'vitalspirit') return 0;
			return hitRate * 0.20; // sleep is huge
		case 'yawn':
			return 0.08; // delayed sleep, often forces switch
		case 'stealthrock':
			return 0.10; // hazard value
		case 'spikes':
			return 0.06;
		case 'toxicspikes':
			return 0.05;
		case 'defog':
		case 'rapidspin':
			return 0.05; // hazard removal
		case 'reflect':
		case 'lightscreen':
			return 0.08;
		case 'auroraveil':
			return 0.12;
		default:
			return 0.02; // generic status move
	}
}

/**
 * Compute an adjusted evaluation from HP deltas after a turn of combat.
 * Blends HP changes into the base evaluation.
 */
function computeHPDeltaEval(
	p1HPAfter: number, p1MaxHP: number,
	p2HPAfter: number, p2MaxHP: number,
	baseEval: number,
): number {
	// HP fractions after combat
	const p1HPFrac = p1HPAfter / p1MaxHP;
	const p2HPFrac = p2HPAfter / p2MaxHP;

	// If either mon fainted, large swing
	if (p1HPAfter <= 0 && p2HPAfter <= 0) return baseEval; // both faint = wash
	if (p1HPAfter <= 0) return clamp(baseEval - 0.35);
	if (p2HPAfter <= 0) return clamp(baseEval + 0.35);

	// Otherwise, shift eval proportional to HP damage dealt
	// (damage to opponent = good for us, damage to us = bad)
	const p1HPLost = 1 - p1HPFrac; // how much of our HP bar was lost
	const p2HPLost = 1 - p2HPFrac; // how much of their HP bar was lost
	const netDamage = p2HPLost - p1HPLost; // positive = we dealt more than we took

	return clamp(baseEval + netDamage * 0.25);
}

function clamp(val: number): number {
	return Math.max(-1, Math.min(1, val));
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
