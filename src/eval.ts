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
	Battle, MonState, FieldState, ShadowTeam, DamageResult, MoveInfo,
} from './types';
import {
	extractFieldState, extractSideState, getActiveMon, isTerminal, getWinValue,
} from './state';
import {
	calcDamageWithCrit, getEffectiveSpeed, calcAllMoves,
	getSpeedComparison, calcSetupTKO,
} from './damage-calc';

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
 * Active matchup: turns-to-KO differential with move-order awareness.
 * Positive if P1 KOs P2 faster than P2 KOs P1.
 *
 * KEY MOVE-ORDER EFFECTS:
 * - If opponent moves first and uses a status move (burn, para, etc.), our
 *   damage output is affected BEFORE we attack. The TKO must reflect this.
 * - If we move first and OHKO, the opponent's action is irrelevant.
 * - Status moves that degrade the opponent's stats (Intimidate switch-in,
 *   stat-lowering moves) are modeled as damage multipliers.
 *
 * Uses the analytical damage calculator's expectedWithCrit for fast estimation.
 */
function evaluateMatchup(
	p1Active: MonState | null,
	p2Active: MonState | null,
	field: FieldState,
): number {
	if (!p1Active || !p2Active) return 0;

	const opts = { field };

	// Determine who goes first using best move priorities
	const p1BestMove = findBestDamagingMove(p1Active);
	const p2BestMove = findBestDamagingMove(p2Active);
	const speedResult = getSpeedComparison(
		p1Active, p1BestMove,
		p2Active, p2BestMove,
		field,
	);
	const p1GoesFirst = speedResult.faster === 'p1';
	const p2GoesFirst = speedResult.faster === 'p2';

	// Compute base damage from each side (best attacking move)
	const p1Moves = calcAllMoves(p1Active, p2Active, opts);
	const p2Moves = calcAllMoves(p2Active, p1Active, opts);

	let p1BestDmg = p1Moves.length > 0 ? p1Moves[0].expectedWithCrit : 0;
	let p2BestDmg = p2Moves.length > 0 ? p2Moves[0].expectedWithCrit : 0;

	// Apply existing status conditions (sleep, freeze, paralysis action denial)
	p1BestDmg *= getStatusDamageMultiplier(p1Active);
	p2BestDmg *= getStatusDamageMultiplier(p2Active);

	// ─── Move-Order Effect: Pre-move status threats ──────────────
	// Check if the FASTER mon can inflict a status that degrades the
	// slower mon's damage output. This is the key move-order insight:
	// if the opponent is faster and has Will-O-Wisp, our physical damage
	// is halved starting turn 1.

	if (p2GoesFirst) {
		// Opponent moves first: check if they have status moves that hurt us
		const p1DmgAdjust = getMoveOrderDamageAdjustment(p2Active, p1Active, p1Moves);
		p1BestDmg *= p1DmgAdjust;
	}
	if (p1GoesFirst) {
		// We move first: check if we have status moves that hurt them
		const p2DmgAdjust = getMoveOrderDamageAdjustment(p1Active, p2Active, p2Moves);
		p2BestDmg *= p2DmgAdjust;
	}

	// Residual damage per turn on the DEFENDER (helps the attacker's TKO)
	const p2Residual = getResidualDamagePerTurn(p2Active);
	const p1Residual = getResidualDamagePerTurn(p1Active);

	// Move-order status may ALSO add new residual damage (burn DOT, toxic, etc.)
	const p1NewResidual = p2GoesFirst ? getPreMoveStatusResidual(p2Active, p1Active) : 0;
	const p2NewResidual = p1GoesFirst ? getPreMoveStatusResidual(p1Active, p2Active) : 0;

	// Effective damage per turn = move damage + residual on defender
	const p1EffDmg = p1BestDmg + p2Residual + p2NewResidual;
	const p2EffDmg = p2BestDmg + p1Residual + p1NewResidual;

	// Turns to KO (using effective damage per turn vs remaining HP)
	let p1TKO = p1EffDmg > 0 ? Math.ceil(p2Active.hp / p1EffDmg) : Infinity;
	let p2TKO = p2EffDmg > 0 ? Math.ceil(p1Active.hp / p2EffDmg) : Infinity;

	// ─── Setup Move TKO Projection ─────────────────────────────
	// If a mon has setup moves, compute the optimal setup+attack TKO.
	// Only count setup as viable if the mon can survive long enough to set up.
	const p1SetupTKO = computeSetupTKO(p1Active, p2Active, p2EffDmg, opts);
	const p2SetupTKO = computeSetupTKO(p2Active, p1Active, p1EffDmg, opts);

	if (p1SetupTKO < p1TKO) p1TKO = p1SetupTKO;
	if (p2SetupTKO < p2TKO) p2TKO = p2SetupTKO;

	// ─── Move-Order Effect: OHKO-before-action ───────────────────
	// If we move first and OHKO, opponent's action is irrelevant → pure win
	if (p1GoesFirst && p1BestDmg >= p2Active.hp) {
		return 1.0; // We OHKO before opponent acts
	}
	if (p2GoesFirst && p2BestDmg >= p1Active.hp) {
		return -1.0; // Opponent OHKOs us before we act
	}

	// Convert TKO differential to [-1, 1]
	if (p1TKO === Infinity && p2TKO === Infinity) return 0;
	if (p1TKO === Infinity) return -0.8;
	if (p2TKO === Infinity) return 0.8;

	// TKO advantage: positive means P1 KOs faster
	let tkoAdvantage = p2TKO - p1TKO;

	// Speed bonus: going first matters most when TKO counts are equal
	// The faster player wins the "same TKO" race
	if (p1GoesFirst && p1TKO <= p2TKO) tkoAdvantage += 0.5;
	if (p2GoesFirst && p2TKO <= p1TKO) tkoAdvantage -= 0.5;

	// Map to [-1, 1] using tanh-like clamping
	return Math.max(-1, Math.min(1, tkoAdvantage / 3));
}

/**
 * Find the best damaging move from a mon's moveset (for speed comparison).
 * Returns null if no damaging moves.
 */
function findBestDamagingMove(mon: MonState): MoveInfo | null {
	let best: MoveInfo | null = null;
	let bestBP = 0;
	for (const m of mon.moves) {
		if (m.disabled || m.category === 'Status' || m.pp <= 0) continue;
		if (m.basePower > bestBP) {
			bestBP = m.basePower;
			best = m;
		}
	}
	return best;
}

/**
 * Compute the optimal setup+attack TKO for an attacker against a defender.
 *
 * Finds setup moves in the attacker's moveset (Calm Mind, Swords Dance, etc.)
 * and evaluates whether setting up N times then attacking is faster than
 * attacking immediately. Accounts for damage taken during setup turns.
 *
 * Returns the best setup TKO, or Infinity if setup isn't viable/beneficial.
 *
 * @param attacker - The mon considering setup
 * @param defender - The opposing mon
 * @param defenderDmgPerTurn - Expected damage the defender deals per turn
 * @param opts - Calc options (field, etc.)
 */
function computeSetupTKO(
	attacker: MonState,
	defender: MonState,
	defenderDmgPerTurn: number,
	opts: { field: FieldState },
): number {
	// Find setup moves in attacker's moveset
	const setupMoves = attacker.moves.filter(m =>
		!m.disabled && m.pp > 0 && m.category === 'Status' &&
		m.boosts && (m.target === 'self' || m.target === 'allies' || m.target === 'allyTeam')
	);
	if (setupMoves.length === 0) return Infinity;

	// Find best attacking moves to use after setup
	const attackMoves = attacker.moves.filter(m =>
		!m.disabled && m.pp > 0 && m.category !== 'Status'
	);
	if (attackMoves.length === 0) return Infinity;

	let bestTKO = Infinity;

	for (const setupMove of setupMoves) {
		if (!setupMove.boosts) continue;

		// Determine which offensive stats are boosted
		const boostsAtk = (setupMove.boosts as Record<string, number>).atk || 0;
		const boostsSpa = (setupMove.boosts as Record<string, number>).spa || 0;
		const boostsDef = (setupMove.boosts as Record<string, number>).def || 0;
		const boostsSpd = (setupMove.boosts as Record<string, number>).spd || 0;
		const boostsSpe = (setupMove.boosts as Record<string, number>).spe || 0;

		// Only consider setups that boost offense or useful defense
		if (boostsAtk <= 0 && boostsSpa <= 0 && boostsDef <= 0 && boostsSpd <= 0 && boostsSpe <= 0) continue;

		for (const attackMove of attackMoves) {
			// Use calcSetupTKO to find optimal setup count
			const recoveryPerTurn = estimateDefenderRecovery(defender);
			const result = calcSetupTKO(
				attacker, defender, attackMove,
				setupMove.boosts as Partial<Record<string, number>>,
				recoveryPerTurn, opts,
			);

			if (!result.breaksThrough) continue;

			// Account for damage taken during setup turns:
			// During setupTurns, the attacker takes defenderDmgPerTurn each turn.
			// Check if attacker survives long enough.
			let setupTurns = result.setupTurns;
			if (setupTurns > 0 && defenderDmgPerTurn > 0) {
				const dmgDuringSetup = defenderDmgPerTurn * setupTurns;
				if (dmgDuringSetup >= attacker.hp) {
					// Can't survive the setup phase. Try fewer boosts.
					const maxSurvivableTurns = Math.floor((attacker.hp - 1) / defenderDmgPerTurn);
					if (maxSurvivableTurns <= 0) continue;
					// Recompute with capped setup turns
					setupTurns = maxSurvivableTurns;
				}
				// Adjust: attacker HP will be lower after setup, so it needs to
				// survive the attack phase too. The total TKO from the defender's
				// perspective includes setup turns + attack turns, so the attacker
				// must survive that many turns of incoming damage.
				const hpAfterSetup = attacker.hp - defenderDmgPerTurn * setupTurns;
				if (hpAfterSetup <= 0) continue;

				// Re-evaluate: with setupTurns boosts, how many attack turns?
				const boosted = { ...attacker, boosts: { ...attacker.boosts } };
				for (const [stat, boost] of Object.entries(setupMove.boosts as Record<string, number>)) {
					const key = stat as keyof typeof boosted.boosts;
					if (key in boosted.boosts) {
						boosted.boosts[key] = Math.min(6, (boosted.boosts[key] || 0) + boost * setupTurns);
					}
				}
				const dmgResult = calcDamageWithCrit(boosted, defender, attackMove, opts);
				const netDmg = dmgResult.expectedWithAccuracy - recoveryPerTurn;
				if (netDmg <= 0) continue;

				const attackTurns = Math.ceil(defender.hp / netDmg);
				const totalTurns = setupTurns + attackTurns;

				// Also verify attacker survives the attack phase
				const totalDmgTaken = defenderDmgPerTurn * totalTurns;
				if (totalDmgTaken >= attacker.hp) {
					// Won't survive to finish attacking. Still might be better than
					// the unboosted TKO if it's close.
					continue;
				}

				if (totalTurns < bestTKO) bestTKO = totalTurns;
			} else {
				// Defender deals no damage (we can set up for free)
				if (result.turnsToKO < bestTKO) bestTKO = result.turnsToKO;
			}
		}
	}

	return bestTKO;
}

/**
 * Estimate defender's per-turn recovery (Leftovers, Recover usage, etc.).
 * Used for setup TKO calculation.
 */
function estimateDefenderRecovery(defender: MonState): number {
	let recovery = 0;

	// Leftovers/Black Sludge: 1/16 maxHP
	if (defender.itemId === 'leftovers' ||
		(defender.itemId === 'blacksludge' && defender.types.includes('Poison'))) {
		recovery += Math.floor(defender.maxhp / 16);
	}

	// Check for healing moves (Recover, Roost, etc.)
	// If the defender has a reliable recovery move, estimate 50% chance they use it
	// each turn → 0.5 * healAmount
	for (const move of defender.moves) {
		if (move.disabled || move.pp <= 0) continue;
		if (move.heal) {
			const healAmount = Math.floor(defender.maxhp * move.heal[0] / move.heal[1]);
			// Weight: 50% usage rate (they might attack instead)
			recovery += healAmount * 0.5;
			break; // Only count one healing move
		}
	}

	return recovery;
}

/**
 * Calculate a damage multiplier [0, 1] reflecting how much the faster mon's
 * status moves degrade the slower mon's damage output.
 *
 * Key scenarios:
 * - Will-O-Wisp on a physical attacker → 0.5x damage (burn halves physical)
 * - Thunder Wave on a fast sweeper → 0.75x (para action denial) + speed halved
 * - Strength Sap / stat-lowering → modest reduction
 *
 * We look at what the faster mon COULD use (their moveset) and whether it
 * would actually affect the slower mon's best attack.
 */
function getMoveOrderDamageAdjustment(
	fasterMon: MonState,
	slowerMon: MonState,
	slowerMoves: DamageResult[],
): number {
	// If slower mon already has the status, no further degradation
	if (slowerMon.status) return 1.0;

	// Check if slower mon's best attack is physical or special
	const bestAttack = slowerMoves.length > 0 ? slowerMoves[0] : null;
	const isPhysicalAttacker = bestAttack
		? slowerMon.moves.find(m => m.name === bestAttack.moveName)?.category === 'Physical'
		: false;

	let multiplier = 1.0;

	for (const move of fasterMon.moves) {
		if (move.disabled || move.pp <= 0) continue;

		// Will-O-Wisp: burns physical attackers → 0.5x physical damage
		if (move.id === 'willowisp' && isPhysicalAttacker) {
			// Guts users BENEFIT from burn, so no penalty
			if (slowerMon.abilityId === 'guts') continue;
			// Fire-types and already-burned mons are immune
			if (slowerMon.types.includes('Fire')) continue;
			// Accuracy-weighted: WoW has 85% accuracy
			const hitRate = (move.accuracy === true) ? 1 : (move.accuracy as number) / 100;
			// If burn lands, physical damage halved; if misses, normal damage
			multiplier = Math.min(multiplier, 1 - hitRate * 0.5);
			break; // One burn is enough, no stacking
		}

		// Scald / Lava Plume etc. with burn secondary — only matters if faster
		if (move.id === 'scald' || move.id === 'lavaplume' || move.id === 'scorchingsands') {
			if (isPhysicalAttacker && slowerMon.abilityId !== 'guts' && !slowerMon.types.includes('Fire')) {
				// 30% burn chance (scald/lava plume)
				const burnChance = 0.3;
				multiplier = Math.min(multiplier, 1 - burnChance * 0.5);
			}
		}

		// Thunder Wave: action denial (25%) + speed halved
		if (move.id === 'thunderwave') {
			// Electric-type immune, Ground-type immune, Limber immune
			if (slowerMon.types.includes('Electric')) continue;
			if (slowerMon.types.includes('Ground')) continue;
			if (slowerMon.abilityId === 'limber') continue;
			const hitRate = (move.accuracy === true) ? 1 : (move.accuracy as number) / 100;
			// Para = 75% action rate
			multiplier = Math.min(multiplier, 1 - hitRate * 0.25);
		}

		// Nuzzle: 100% para chance, also deals damage
		if (move.id === 'nuzzle') {
			if (slowerMon.types.includes('Electric') || slowerMon.types.includes('Ground')) continue;
			if (slowerMon.abilityId === 'limber') continue;
			multiplier = Math.min(multiplier, 0.75);
		}

		// Glare / Stun Spore: para
		if (move.id === 'glare' || move.id === 'stunspore') {
			if (slowerMon.types.includes('Electric')) continue;
			if (move.id === 'stunspore' && slowerMon.types.includes('Grass')) continue;
			if (slowerMon.abilityId === 'limber') continue;
			const hitRate = (move.accuracy === true) ? 1 : (move.accuracy as number) / 100;
			multiplier = Math.min(multiplier, 1 - hitRate * 0.25);
		}

		// Intimidate-like stat drops: Parting Shot, Memento
		if (move.id === 'partingshot' && isPhysicalAttacker) {
			// -1 Atk = ~0.67x damage at +0
			multiplier = Math.min(multiplier, 0.67);
		}

		// Charm / Feather Dance: -2 Atk
		if ((move.id === 'charm' || move.id === 'featherdance') && isPhysicalAttacker) {
			if (slowerMon.abilityId === 'contrary') continue; // Contrary makes it +2
			multiplier = Math.min(multiplier, 0.5); // -2 Atk = 0.5x
		}

		// Spore / Sleep Powder / Lovely Kiss / Dark Void: sleep = 0 damage
		if (move.id === 'spore' || move.id === 'sleeppowder' || move.id === 'lovelykiss' ||
			move.id === 'darkvoid' || move.id === 'hypnosis' || move.id === 'yawn') {
			// Grass types immune to powder moves (Spore, Sleep Powder)
			if (slowerMon.types.includes('Grass') &&
				(move.id === 'spore' || move.id === 'sleeppowder')) continue;
			if (slowerMon.abilityId === 'insomnia' || slowerMon.abilityId === 'vitalspirit') continue;
			if (slowerMon.abilityId === 'overcoat' && move.flags?.powder) continue;
			// Yawn has a 1-turn delay, so less impactful in TKO calc
			if (move.id === 'yawn') {
				multiplier = Math.min(multiplier, 0.5); // delayed sleep = ~50% reduction
			} else {
				const hitRate = (move.accuracy === true) ? 1 : (move.accuracy as number) / 100;
				// Sleep = can't attack (except Sleep Talk)
				const hasSleepTalk = slowerMon.moves.some(m => m.id === 'sleeptalk');
				const sleepPenalty = hasSleepTalk ? 0.5 : 1.0;
				multiplier = Math.min(multiplier, 1 - hitRate * sleepPenalty);
			}
		}
	}

	return multiplier;
}

/**
 * Estimate additional residual damage per turn that a faster mon's status
 * moves would inflict on the slower mon (beyond their existing status).
 *
 * E.g., if faster mon has Will-O-Wisp and slower mon isn't burned yet,
 * the burn DOT (1/16 maxHP) should be factored into our TKO calculation.
 */
function getPreMoveStatusResidual(
	fasterMon: MonState,
	slowerMon: MonState,
): number {
	// If slower mon already has a status, no new residual can be applied
	if (slowerMon.status) return 0;

	for (const move of fasterMon.moves) {
		if (move.disabled || move.pp <= 0) continue;

		// Will-O-Wisp → burn DOT: 1/16 maxHP
		if (move.id === 'willowisp') {
			if (slowerMon.types.includes('Fire')) continue;
			const hitRate = (move.accuracy === true) ? 1 : (move.accuracy as number) / 100;
			return Math.floor(slowerMon.maxhp / 16) * hitRate;
		}

		// Toxic → toxic DOT: starts at 1/16, escalates. Average ~1/8 for TKO estimate.
		if (move.id === 'toxic') {
			if (slowerMon.types.includes('Poison') || slowerMon.types.includes('Steel')) continue;
			const hitRate = (move.accuracy === true) ? 1 : (move.accuracy as number) / 100;
			return Math.floor(slowerMon.maxhp / 8) * hitRate;
		}

		// Scald burn secondary: 30% chance → 0.3 * 1/16 maxHP
		if (move.id === 'scald' || move.id === 'lavaplume' || move.id === 'scorchingsands') {
			if (slowerMon.types.includes('Fire')) continue;
			return Math.floor(slowerMon.maxhp / 16) * 0.3;
		}
	}

	return 0;
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
