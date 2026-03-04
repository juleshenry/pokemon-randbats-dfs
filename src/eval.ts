/**
 * eval.ts — Position evaluation heuristic
 *
 * Evaluates a battle position from P1's perspective on a [-1, 1] scale.
 * -1 = P2 winning decisively, 0 = even, +1 = P1 winning decisively.
 *
 * Components:
 *   HP ratio advantage:         0.25 weight
 *   Pokemon count advantage:    0.20 weight
 *   Active matchup TKO diff:    0.30 weight
 *   Setup progress advantage:   0.15 weight
 *   Hazard advantage:           0.10 weight
 *
 * Shadow team feeds a "risk penalty" for likely unrevealed threats.
 */

import type {
	Battle, MonState, FieldState, ShadowTeam,
} from './types';
import {
	extractFieldState, extractSideState, getActiveMon, isTerminal, getWinValue,
} from './state';
import { calcDamageWithCrit, getEffectiveSpeed, calcAllMoves } from './damage-calc';

// ─── Weight Constants ───────────────────────────────────────────

const W_HP = 0.25;
const W_COUNT = 0.20;
const W_MATCHUP = 0.30;
const W_SETUP = 0.15;
const W_HAZARD = 0.10;

/** Maximum risk penalty from shadow team threats */
const MAX_SHADOW_RISK = 0.15;

// ─── Main Evaluation ────────────────────────────────────────────

/**
 * Evaluate a battle position from P1's perspective.
 * Returns a value in [-1, 1].
 *
 * @param battle - The battle state to evaluate
 * @param shadow - Optional shadow team for unrevealed threat assessment
 * @returns Evaluation score [-1, 1]
 */
export function evaluate(battle: Battle, shadow?: ShadowTeam): number {
	// Terminal states: return exact values
	const winVal = getWinValue(battle);
	if (winVal !== null) return winVal;

	const field = extractFieldState(battle);
	const p1Mons = extractSideState(battle, 0);
	const p2Mons = extractSideState(battle, 1);
	const p1Active = getActiveMon(battle, 0);
	const p2Active = getActiveMon(battle, 1);

	// Component scores, each in [-1, 1]
	const hpScore = evaluateHP(p1Mons, p2Mons);
	const countScore = evaluateCount(p1Mons, p2Mons);
	const matchupScore = evaluateMatchup(p1Active, p2Active, field);
	const setupScore = evaluateSetup(p1Active, p2Active);
	const hazardScore = evaluateHazards(field, p1Mons, p2Mons);

	let eval_ = (
		W_HP * hpScore +
		W_COUNT * countScore +
		W_MATCHUP * matchupScore +
		W_SETUP * setupScore +
		W_HAZARD * hazardScore
	);

	// Shadow team risk penalty
	if (shadow && p1Active) {
		const riskPenalty = evaluateShadowRisk(shadow, p1Active, p1Mons);
		eval_ -= riskPenalty;
	}

	// Clamp to [-1, 1]
	return Math.max(-1, Math.min(1, eval_));
}

// ─── Component Evaluators ───────────────────────────────────────

/**
 * HP ratio advantage: (P1 total HP% - P2 total HP%) / 2
 * Using percentage HP to normalize across different team sizes.
 */
function evaluateHP(p1Mons: MonState[], p2Mons: MonState[]): number {
	const p1HP = totalHPPercent(p1Mons);
	const p2HP = totalHPPercent(p2Mons);
	// Difference normalized: if P1 has 100% and P2 has 0%, score = 1.0
	return p1HP - p2HP;
}

function totalHPPercent(mons: MonState[]): number {
	if (mons.length === 0) return 0;
	let total = 0;
	let count = 0;
	for (const m of mons) {
		if (!m.fainted) {
			total += m.hp / m.maxhp;
			count++;
		}
	}
	return count > 0 ? total / mons.length : 0;
}

/**
 * Pokemon count advantage: (P1 alive - P2 alive) / max(P1 total, P2 total)
 */
function evaluateCount(p1Mons: MonState[], p2Mons: MonState[]): number {
	const p1Alive = p1Mons.filter(m => !m.fainted).length;
	const p2Alive = p2Mons.filter(m => !m.fainted).length;
	const maxTotal = Math.max(p1Mons.length, p2Mons.length, 1);
	return (p1Alive - p2Alive) / maxTotal;
}

/**
 * Active matchup: turns-to-KO differential.
 * Positive if P1 KOs P2 faster than P2 KOs P1.
 *
 * Uses the analytical damage calculator's expectedWithCrit for fast estimation.
 * Accounts for status conditions that affect action (sleep, freeze, paralysis).
 */
function evaluateMatchup(
	p1Active: MonState | null,
	p2Active: MonState | null,
	field: FieldState,
): number {
	if (!p1Active || !p2Active) return 0;

	// Best move damage from each side
	const opts = { field };
	const p1Moves = calcAllMoves(p1Active, p2Active, opts);
	const p2Moves = calcAllMoves(p2Active, p1Active, opts);

	let p1BestDmg = p1Moves.length > 0 ? p1Moves[0].expectedWithCrit : 0;
	let p2BestDmg = p2Moves.length > 0 ? p2Moves[0].expectedWithCrit : 0;

	// Status action denial / discount:
	// Sleep: can't attack unless using Sleep Talk. Approximate as 0 damage.
	// Freeze: can't attack (20% thaw chance per turn, but unreliable). Approximate as 0.
	// Paralysis: 25% chance of full paralysis per turn → multiply damage by 0.75.
	p1BestDmg *= getStatusDamageMultiplier(p1Active);
	p2BestDmg *= getStatusDamageMultiplier(p2Active);

	// Residual damage per turn on the DEFENDER (helps the attacker's TKO)
	// Burn: 1/16 maxhp per turn. Poison: 1/8 maxhp. Toxic: escalates (avg ~1/8).
	const p2Residual = getResidualDamagePerTurn(p2Active);
	const p1Residual = getResidualDamagePerTurn(p1Active);

	// Effective damage per turn = move damage + residual on defender
	const p1EffDmg = p1BestDmg + p2Residual;
	const p2EffDmg = p2BestDmg + p1Residual;

	// Turns to KO (using effective damage per turn vs remaining HP)
	const p1TKO = p1EffDmg > 0 ? Math.ceil(p2Active.hp / p1EffDmg) : Infinity;
	const p2TKO = p2EffDmg > 0 ? Math.ceil(p1Active.hp / p2EffDmg) : Infinity;

	// Speed determines who attacks first
	const p1Speed = getEffectiveSpeed(p1Active, field);
	const p2Speed = getEffectiveSpeed(p2Active, field);

	// Priority consideration
	const p1Priority = p1Moves.length > 0 ? (p1Moves[0].moveName ? getPriority(p1Active, p1Moves[0].moveName) : 0) : 0;
	const p2Priority = p2Moves.length > 0 ? (p2Moves[0].moveName ? getPriority(p2Active, p2Moves[0].moveName) : 0) : 0;

	const p1GoesFirst = p1Priority > p2Priority || (p1Priority === p2Priority && p1Speed > p2Speed);

	// Convert TKO differential to [-1, 1] using sigmoid-like function
	if (p1TKO === Infinity && p2TKO === Infinity) return 0; // neither can KO
	if (p1TKO === Infinity) return -0.8; // P1 can't KO, P2 can
	if (p2TKO === Infinity) return 0.8;  // P1 can KO, P2 can't

	// TKO advantage: negative means P1 KOs faster
	let tkoAdvantage = p2TKO - p1TKO;

	// Speed bonus: going first matters most when TKO is close
	if (p1GoesFirst && p1TKO <= p2TKO) tkoAdvantage += 0.5;
	if (!p1GoesFirst && p2TKO <= p1TKO) tkoAdvantage -= 0.5;

	// Map to [-1, 1] using tanh-like clamping
	return Math.max(-1, Math.min(1, tkoAdvantage / 3));
}

/**
 * Get a damage multiplier based on the attacker's status condition.
 * Sleep/freeze = can't act (0x). Paralysis = 25% full para (0.75x).
 * Sleep Talk users are exempt from sleep penalty.
 */
function getStatusDamageMultiplier(mon: MonState): number {
	if (!mon.status) return 1;

	if (mon.status === 'slp') {
		// Check for Sleep Talk — if the mon has it, they can still attack
		const hasSleepTalk = mon.moves.some(m => m.id === 'sleeptalk');
		if (hasSleepTalk) return 0.5; // Sleep Talk is 50/50 useful
		return 0; // can't attack while sleeping
	}

	if (mon.status === 'frz') {
		return 0; // frozen, 20% thaw is too unreliable to count on
	}

	if (mon.status === 'par') {
		return 0.75; // 25% chance of full paralysis
	}

	return 1;
}

/**
 * Get residual damage per turn from a mon's status condition.
 * Returns absolute HP damage per turn.
 *
 * Burn: 1/16 maxHP. Poison: 1/8 maxHP.
 * Toxic: escalates (1/16 * N per turn), use current statusTurns for estimate.
 */
function getResidualDamagePerTurn(mon: MonState): number {
	if (!mon.status) return 0;

	if (mon.status === 'brn') {
		return Math.floor(mon.maxhp / 16);
	}
	if (mon.status === 'psn') {
		return Math.floor(mon.maxhp / 8);
	}
	if (mon.status === 'tox') {
		// Toxic escalates: turn 1 = 1/16, turn 2 = 2/16, etc.
		// Use statusTurns if available for more accurate estimate
		const toxTurn = Math.max(1, mon.statusTurns || 1);
		return Math.floor(mon.maxhp * toxTurn / 16);
	}

	return 0;
}

/**
 * Get the priority of the best damaging move from a mon's move list.
 */
function getPriority(mon: MonState, moveName: string): number {
	for (const m of mon.moves) {
		if (m.name === moveName) return m.priority;
	}
	return 0;
}

/**
 * Setup progress: boost advantage.
 * Positive boosts for P1, negative for P2.
 * Attack boosts matter more than defense boosts.
 */
function evaluateSetup(p1Active: MonState | null, p2Active: MonState | null): number {
	if (!p1Active && !p2Active) return 0;

	const p1Boost = p1Active ? boostValue(p1Active) : 0;
	const p2Boost = p2Active ? boostValue(p2Active) : 0;

	// Map difference to [-1, 1]
	const diff = p1Boost - p2Boost;
	return Math.max(-1, Math.min(1, diff / 4));
}

/**
 * Compute a single "boost score" for a Pokemon.
 * Offensive boosts (atk, spa, spe) weighted more than defensive.
 */
function boostValue(mon: MonState): number {
	const b = mon.boosts;
	return (
		b.atk * 1.0 +
		b.spa * 1.0 +
		b.spe * 0.8 +
		b.def * 0.4 +
		b.spd * 0.4 -
		(b.accuracy < 0 ? b.accuracy * 0.5 : 0) +
		(b.evasion > 0 ? b.evasion * 0.3 : 0)
	);
}

/**
 * Hazard advantage: value of hazards on the opponent's side
 * minus hazards on our side.
 */
function evaluateHazards(field: FieldState, p1Mons: MonState[], p2Mons: MonState[]): number {
	// Hazard value on each side (higher = worse for that side's team)
	const p1HazardPenalty = hazardPenalty(field.p1Hazards, p1Mons);
	const p2HazardPenalty = hazardPenalty(field.p2Hazards, p2Mons);

	// Screen value on each side (higher = better for that side)
	const p1ScreenValue = screenValue(field.p1Screens);
	const p2ScreenValue = screenValue(field.p2Screens);

	// P1 perspective: opponent hazards help us, our hazards hurt us
	const advantage = (p2HazardPenalty - p1HazardPenalty) + (p1ScreenValue - p2ScreenValue);

	// Normalize to [-1, 1]
	return Math.max(-1, Math.min(1, advantage / 0.5));
}

/**
 * Estimate the value of hazards on a side.
 * Based on switching damage to remaining mons.
 */
function hazardPenalty(hazards: any, mons: MonState[]): number {
	let penalty = 0;
	const alive = mons.filter(m => !m.fainted && !m.isActive);

	if (hazards.stealthrock) {
		// Stealth Rock: 12.5% to 50% depending on type
		for (const m of alive) {
			const srDmg = getStealthRockDamage(m);
			penalty += srDmg;
		}
	}

	if (hazards.spikes > 0) {
		// Spikes: 12.5% / 16.7% / 25% for 1/2/3 layers (grounded only)
		const spikeDmg = [0, 1/8, 1/6, 1/4][hazards.spikes] || 0;
		for (const m of alive) {
			if (isGrounded(m)) {
				penalty += spikeDmg;
			}
		}
	}

	if (hazards.toxicspikes > 0) {
		// Toxic Spikes: poisons grounded non-Poison mons
		for (const m of alive) {
			if (isGrounded(m) && !m.types.includes('Poison') && !m.types.includes('Steel')) {
				penalty += hazards.toxicspikes === 2 ? 0.1 : 0.05; // toxic vs poison
			}
		}
	}

	if (hazards.stickyweb) {
		// Sticky Web: -1 Speed on switch-in for grounded mons
		for (const m of alive) {
			if (isGrounded(m)) {
				penalty += 0.03;
			}
		}
	}

	return alive.length > 0 ? penalty / alive.length : 0;
}

/**
 * Stealth Rock damage as fraction of maxHP.
 */
function getStealthRockDamage(mon: MonState): number {
	// Type effectiveness of Rock vs mon's types
	let eff = 1;
	for (const type of mon.types) {
		const e = typeEffVsType('Rock', type);
		eff *= e;
	}
	return 0.125 * eff;
}

/**
 * Simple type effectiveness multiplier for one type pair.
 */
function typeEffVsType(atkType: string, defType: string): number {
	// Use a hardcoded table for the most common SR interactions
	const chart: Record<string, Record<string, number>> = {
		Rock: {
			Fire: 2, Ice: 2, Flying: 2, Bug: 2,
			Fighting: 0.5, Ground: 0.5, Steel: 0.5,
			Normal: 1, Water: 1, Grass: 1, Electric: 1,
			Psychic: 1, Ghost: 1, Dragon: 1, Dark: 1,
			Fairy: 1, Poison: 1,
		},
	};
	return chart[atkType]?.[defType] ?? 1;
}

/**
 * Check if a Pokemon is grounded (affected by Spikes/Toxic Spikes/Sticky Web).
 */
function isGrounded(mon: MonState): boolean {
	if (mon.types.includes('Flying')) return false;
	if (mon.abilityId === 'levitate') return false;
	if (mon.itemId === 'airballoon') return false;
	// Iron Ball forces grounding, but that's rare in random battles
	return true;
}

/**
 * Value of screens on a side [0, ~0.3].
 */
function screenValue(screens: any): number {
	let value = 0;
	if (screens.reflect > 0) value += 0.08 * Math.min(screens.reflect, 5) / 5;
	if (screens.lightscreen > 0) value += 0.08 * Math.min(screens.lightscreen, 5) / 5;
	if (screens.auroraveil > 0) value += 0.12 * Math.min(screens.auroraveil, 5) / 5;
	return value;
}

// ─── Shadow Team Risk ───────────────────────────────────────────

/**
 * Evaluate risk from unrevealed opponents.
 * Returns a penalty [0, MAX_SHADOW_RISK] based on how threatened
 * our team is by likely unrevealed candidates.
 */
function evaluateShadowRisk(
	shadow: ShadowTeam,
	p1Active: MonState,
	p1Mons: MonState[],
): number {
	if (shadow.slotsRemaining <= 0) return 0;

	let riskScore = 0;
	let totalWeight = 0;

	for (const [, candidate] of shadow.candidates) {
		// Check if candidate's STAB threatens our active mon
		let isThreat = false;
		for (const type of candidate.types) {
			// Simple SE check
			let eff = 1;
			for (const defType of p1Active.types) {
				const e = typeEffVsType(type, defType);
				if (e !== 1) eff *= e;
			}
			// Expanded SE check using our type chart
			if (eff === 1) {
				// Fallback: check common SE matchups
				for (const defType of p1Active.types) {
					if (isSuperEffective(type, defType)) {
						isThreat = true;
						break;
					}
				}
			} else if (eff > 1) {
				isThreat = true;
			}
			if (isThreat) break;
		}

		if (isThreat) {
			riskScore += candidate.weight;
		}
		totalWeight += candidate.weight;
	}

	if (totalWeight <= 0) return 0;

	// Risk is the weighted fraction of threatening candidates × slotsRemaining factor
	const threatFraction = riskScore / totalWeight;
	const slotFactor = Math.min(shadow.slotsRemaining / 6, 1);

	return MAX_SHADOW_RISK * threatFraction * slotFactor;
}

/**
 * Extended SE check for common attack types.
 * This is a simplified version for shadow team risk assessment.
 */
function isSuperEffective(atkType: string, defType: string): boolean {
	const seChart: Record<string, string[]> = {
		Fire: ['Grass', 'Ice', 'Bug', 'Steel'],
		Water: ['Fire', 'Ground', 'Rock'],
		Grass: ['Water', 'Ground', 'Rock'],
		Electric: ['Water', 'Flying'],
		Ice: ['Grass', 'Ground', 'Flying', 'Dragon'],
		Fighting: ['Normal', 'Ice', 'Rock', 'Dark', 'Steel'],
		Poison: ['Grass', 'Fairy'],
		Ground: ['Fire', 'Electric', 'Poison', 'Rock', 'Steel'],
		Flying: ['Grass', 'Fighting', 'Bug'],
		Psychic: ['Fighting', 'Poison'],
		Bug: ['Grass', 'Psychic', 'Dark'],
		Rock: ['Fire', 'Ice', 'Flying', 'Bug'],
		Ghost: ['Psychic', 'Ghost'],
		Dragon: ['Dragon'],
		Dark: ['Psychic', 'Ghost'],
		Steel: ['Ice', 'Rock', 'Fairy'],
		Fairy: ['Fighting', 'Dragon', 'Dark'],
		Normal: [],
	};
	return seChart[atkType]?.includes(defType) ?? false;
}

// ─── Batch Evaluation ───────────────────────────────────────────

/**
 * Evaluate a position with component breakdown (useful for debugging).
 */
export function evaluateDetailed(battle: Battle, shadow?: ShadowTeam): {
	total: number;
	hp: number;
	count: number;
	matchup: number;
	setup: number;
	hazards: number;
	shadowRisk: number;
} {
	const winVal = getWinValue(battle);
	if (winVal !== null) {
		return {
			total: winVal,
			hp: winVal,
			count: winVal,
			matchup: 0,
			setup: 0,
			hazards: 0,
			shadowRisk: 0,
		};
	}

	const field = extractFieldState(battle);
	const p1Mons = extractSideState(battle, 0);
	const p2Mons = extractSideState(battle, 1);
	const p1Active = getActiveMon(battle, 0);
	const p2Active = getActiveMon(battle, 1);

	const hp = evaluateHP(p1Mons, p2Mons);
	const count = evaluateCount(p1Mons, p2Mons);
	const matchup = evaluateMatchup(p1Active, p2Active, field);
	const setup = evaluateSetup(p1Active, p2Active);
	const hazards = evaluateHazards(field, p1Mons, p2Mons);

	let shadowRisk = 0;
	if (shadow && p1Active) {
		shadowRisk = evaluateShadowRisk(shadow, p1Active, p1Mons);
	}

	const total = Math.max(-1, Math.min(1,
		W_HP * hp +
		W_COUNT * count +
		W_MATCHUP * matchup +
		W_SETUP * setup +
		W_HAZARD * hazards -
		shadowRisk
	));

	return { total, hp, count, matchup, setup, hazards, shadowRisk };
}
