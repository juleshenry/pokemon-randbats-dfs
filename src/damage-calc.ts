/**
 * damage-calc.ts — Analytical expected-value damage calculator
 *
 * Implements the Gen 9 damage formula analytically (no sim branching).
 * Uses accuracy-weighted expected values and crit probability folding.
 *
 * Formula (from PS sim/battle-actions.ts):
 *   baseDamage = tr(tr(tr(tr(2*L/5 + 2) * BP * A) / D) / 50) + 2
 *
 * Then modifiers applied in order:
 *   spread → weather → crit → random[85..100] → STAB → type eff → burn → final mods
 *
 * We compute min (roll=85), max (roll=100), and expected (avg roll ~92.5).
 * Accuracy folding: expectedWithAccuracy = expected * (accuracy/100).
 * Crit folding: expectedWithCrit = (1-critRate)*normalDmg + critRate*critDmg.
 */

import type {
	MonState, MoveInfo, FieldState, DamageResult, TurnsToKOResult, SpeedResult,
	ScreenState,
} from './types';
import { getTypeEffectiveness, getTypeImmunity, getMove, getDex } from './state';

// ─── Constants ──────────────────────────────────────────────────

/** Gen 7-9 crit denominators by stage: stage 0 = 1/24, 1 = 1/8, 2 = 1/2, 3+ = 1/1 */
const CRIT_MULT = [24, 8, 2, 1, 1];

/** Boost table: multiplier for +0 through +6 */
const BOOST_TABLE = [1, 1.5, 2, 2.5, 3, 3.5, 4];

// ─── Truncation Helpers (match PS sim exactly) ──────────────────

function tr(n: number, bits = 0): number {
	if (bits) return (n >>> 0) % (2 ** bits);
	return n >>> 0;
}

/**
 * PS "pokeRound" modifier: apply a fractional modifier with 4096-based rounding.
 * modify(value, numerator, denominator=1)
 */
function modify(value: number, numerator: number, denominator = 1): number {
	const mod = tr(numerator * 4096 / denominator);
	return tr((tr(value * mod) + 2047) / 4096);
}

/**
 * Chain two 4096-based modifiers together (matches PS chainModify behavior).
 * Returns the combined modifier as a fraction of 4096.
 */
function chainMod(existing4096: number, numerator: number, denominator = 1): number {
	const next4096 = tr(numerator * 4096 / denominator);
	return ((existing4096 * next4096 + 2048) >> 12);
}

// ─── Stat Helpers ────────────────────────────────────────────────

/**
 * Apply boost stages to a stat. Matches PS calculateStat.
 */
function applyBoost(stat: number, boost: number): number {
	const clamped = Math.max(-6, Math.min(6, boost));
	if (clamped >= 0) return Math.floor(stat * BOOST_TABLE[clamped]);
	return Math.floor(stat / BOOST_TABLE[-clamped]);
}

/**
 * Get effective speed, accounting for boosts, paralysis, items, abilities, and Trick Room.
 */
export function getEffectiveSpeed(mon: MonState, field: FieldState): number {
	let speed = applyBoost(mon.stats.spe, mon.boosts.spe);

	// Paralysis halves speed (unless Quick Feet)
	if (mon.status === 'par' && mon.abilityId !== 'quickfeet') {
		speed = Math.floor(speed / 2);
	}

	// Choice Scarf: 1.5x
	if (mon.itemId === 'choicescarf') {
		speed = Math.floor(speed * 1.5);
	}

	// Unburden: 2x (when item consumed — we approximate: if item is '' and ability is unburden)
	if (mon.abilityId === 'unburden' && !mon.itemId) {
		speed = Math.floor(speed * 2);
	}

	// Swift Swim / Chlorophyll / Sand Rush / Slush Rush
	if (mon.abilityId === 'swiftswim' && field.weather === 'RainDance') speed *= 2;
	if (mon.abilityId === 'chlorophyll' && field.weather === 'SunnyDay') speed *= 2;
	if (mon.abilityId === 'sandrush' && field.weather === 'Sandstorm') speed *= 2;
	if (mon.abilityId === 'slushrush' && field.weather === 'Snow') speed *= 2;

	// Surge Surfer: 2x speed in Electric Terrain
	if (mon.abilityId === 'surgesurfer' && field.terrain === 'Electric Terrain') speed *= 2;

	// Quick Feet: 1.5x speed when statused (already prevents paralysis halving above)
	if (mon.abilityId === 'quickfeet' && mon.status) {
		speed = Math.floor(speed * 1.5);
	}

	// Protosynthesis speed boost (1.5x if Spe is highest stat, in Sun or with Booster Energy)
	if (mon.abilityId === 'protosynthesis') {
		const inSun = field.weather === 'SunnyDay' || field.weather === 'Desolate Land';
		const hasBooster = mon.itemId === 'boosterenergy';
		if ((inSun || hasBooster) && getHighestStatName(mon.stats) === 'spe') {
			speed = Math.floor(speed * 1.5);
		}
	}

	// Quark Drive speed boost (1.5x if Spe is highest stat, in Electric Terrain or with Booster Energy)
	if (mon.abilityId === 'quarkdrive') {
		const inTerrain = field.terrain === 'Electric Terrain';
		const hasBooster = mon.itemId === 'boosterenergy';
		if ((inTerrain || hasBooster) && getHighestStatName(mon.stats) === 'spe') {
			speed = Math.floor(speed * 1.5);
		}
	}

	// Iron Ball halves speed
	if (mon.itemId === 'ironball') {
		speed = Math.floor(speed / 2);
	}

	return Math.floor(speed);
}

/**
 * Determine who moves first. Returns SpeedResult.
 */
export function getSpeedComparison(
	p1: MonState, p1Move: MoveInfo | null,
	p2: MonState, p2Move: MoveInfo | null,
	field: FieldState
): SpeedResult {
	const p1Pri = p1Move?.priority ?? 0;
	const p2Pri = p2Move?.priority ?? 0;

	if (p1Pri !== p2Pri) {
		return {
			faster: p1Pri > p2Pri ? 'p1' : 'p2',
			p1Speed: getEffectiveSpeed(p1, field),
			p2Speed: getEffectiveSpeed(p2, field),
			p1Priority: p1Pri,
			p2Priority: p2Pri,
		};
	}

	const p1Spd = getEffectiveSpeed(p1, field);
	const p2Spd = getEffectiveSpeed(p2, field);

	let faster: 'p1' | 'p2' | 'tie';
	if (field.trickRoom > 0) {
		// Trick Room reverses speed (lower goes first)
		faster = p1Spd < p2Spd ? 'p1' : p1Spd > p2Spd ? 'p2' : 'tie';
	} else {
		faster = p1Spd > p2Spd ? 'p1' : p1Spd < p2Spd ? 'p2' : 'tie';
	}

	return { faster, p1Speed: p1Spd, p2Speed: p2Spd, p1Priority: p1Pri, p2Priority: p2Pri };
}

/**
 * Get the defender's effective defensive types, accounting for terastallization.
 * When terastallized (non-Stellar), defensive type becomes [teraType] (single type).
 */
function getDefensiveTypes(defender: MonState): string[] {
	// Tera Stellar does NOT change defensive types (keeps original)
	if (defender.terastallized && defender.teraType && defender.teraType !== 'Stellar') {
		return [defender.teraType];
	}
	return defender.types;
}

// ─── Core Damage Calculation ─────────────────────────────────────

export interface CalcOptions {
	isCrit?: boolean;
	roll?: number;        // 85-100, for specific roll; omit for analytical
	field?: FieldState;
	attackerSide?: 'p1' | 'p2';  // for screen lookup
}

/**
 * Calculate damage for a single move use. Returns DamageResult.
 *
 * This is the core analytical damage function. It implements the Gen 9
 * formula step by step, matching PS sim rounding exactly (for a given roll).
 */
export function calcDamage(
	attacker: MonState,
	defender: MonState,
	move: MoveInfo,
	options: CalcOptions = {}
): DamageResult {
	const field = options.field;

	// Status moves do 0 damage
	if (move.category === 'Status') {
		return makeDamageResult(0, 0, 0, move, defender, 1);
	}

	// Determine move type (respecting Tera type changes, etc.)
	const moveType = move.type;

	// Get the defender's effective defensive types (respects terastallization)
	const defTypes = getDefensiveTypes(defender);

	// Type immunity check (ability-based immunities handled separately)
	if (!getTypeImmunity(moveType, defTypes)) {
		// Check for ability-based immunity overrides
		if (!abilityNegatesImmunity(attacker, defender, moveType)) {
			return makeDamageResult(0, 0, 0, move, defender, 0);
		}
	}

	// Ability-based immunities (Levitate vs Ground, Water Absorb vs Water, etc.)
	if (checkAbilityImmunity(defender, moveType, move)) {
		return makeDamageResult(0, 0, 0, move, defender, 0);
	}

	// Type effectiveness
	// If ability negates immunity (e.g., Scrappy), compute effectiveness ignoring immunities
	const ignoreImmunity = abilityNegatesImmunity(attacker, defender, moveType);
	let effectiveness = ignoreImmunity
		? getTypeEffectivenessNoImmunity(moveType, defTypes)
		: getTypeEffectiveness(moveType, defTypes);

	// Freeze-Dry is super effective against Water
	if (move.id === 'freezedry' && defTypes.includes('Water')) {
		// Water normally resists Ice, but Freeze-Dry is SE vs Water
		// Recalculate: remove Water's resistance to Ice, add SE
		const nonWaterTypes = defTypes.filter(t => t !== 'Water');
		effectiveness = getTypeEffectiveness('Ice', nonWaterTypes) * 2;
	}

	if (effectiveness === 0) {
		return makeDamageResult(0, 0, 0, move, defender, 0);
	}

	// ─── Base Power ─────────────────────────────────
	let basePower = move.basePower;

	// Special BP moves
	basePower = adjustBasePower(basePower, move, attacker, defender);

	// Ability-based BP modifications
	basePower = applyAbilityBasePower(basePower, move, attacker, defender);

	// Terrain BP boosts (grounded attackers only — Levitate/Air Balloon aren't grounded)
	if (field?.terrain) {
		const grounded = attacker.abilityId !== 'levitate' && attacker.itemId !== 'airballoon'
			&& !attacker.types.includes('Flying');
		if (grounded) {
			if (field.terrain === 'Electric Terrain' && moveType === 'Electric') {
				basePower = modify(basePower, 5325, 4096); // 1.3x
			} else if (field.terrain === 'Grassy Terrain' && moveType === 'Grass') {
				basePower = modify(basePower, 5325, 4096); // 1.3x
			} else if (field.terrain === 'Psychic Terrain' && moveType === 'Psychic') {
				basePower = modify(basePower, 5325, 4096); // 1.3x
			}
		}
		// Misty Terrain: halves Dragon damage to grounded defenders
		if (field.terrain === 'Misty Terrain' && moveType === 'Dragon') {
			const defGrounded = defender.abilityId !== 'levitate' && defender.itemId !== 'airballoon'
				&& !defender.types.includes('Flying');
			if (defGrounded) {
				basePower = modify(basePower, 2048, 4096); // 0.5x
			}
		}
	}

	if (basePower <= 0) basePower = 1;

	// ─── Attack and Defense stats ───────────────────
	const isPhysical = move.category === 'Physical';
	const isCrit = options.isCrit ?? false;

	let atkBoost = isPhysical ? attacker.boosts.atk : attacker.boosts.spa;
	let defBoost = isPhysical ? defender.boosts.def : defender.boosts.spd;

	// Psyshock/Psystrike/Secret Sword: special move using physical defense
	if (move.id === 'psyshock' || move.id === 'psystrike' || move.id === 'secretsword') {
		defBoost = defender.boosts.def;
	}

	// Unaware: ignore opponent's boosts
	// Attacking Unaware: ignore defender's positive Def/SpD boosts
	if (attacker.abilityId === 'unaware') {
		if (defBoost > 0) defBoost = 0;
	}
	// Defending against Unaware: ignore attacker's positive Atk/SpA boosts
	if (defender.abilityId === 'unaware') {
		if (atkBoost > 0) atkBoost = 0;
	}

	// Crits ignore negative offensive boosts and positive defensive boosts
	if (isCrit) {
		if (atkBoost < 0) atkBoost = 0;
		if (defBoost > 0) defBoost = 0;
	}

	let attack: number;
	let defense: number;

	if (isPhysical) {
		attack = applyBoost(attacker.stats.atk, atkBoost);
		defense = applyBoost(defender.stats.def, defBoost);
	} else {
		attack = applyBoost(attacker.stats.spa, atkBoost);
		// Psyshock etc: use physical defense stat
		if (move.id === 'psyshock' || move.id === 'psystrike' || move.id === 'secretsword') {
			defense = applyBoost(defender.stats.def, defBoost);
		} else {
			defense = applyBoost(defender.stats.spd, defBoost);
		}
	}

	// ─── Ability stat modifications ─────────────────
	attack = applyAbilityAttackMod(attack, attacker, isPhysical, field, defender);
	defense = applyAbilityDefenseMod(defense, defender, isPhysical, field, attacker);

	// Item stat modifications
	attack = applyItemAttackMod(attack, attacker, isPhysical);
	defense = applyItemDefenseMod(defense, defender, isPhysical);

	// Ensure minimum 1
	if (attack < 1) attack = 1;
	if (defense < 1) defense = 1;

	// ─── Base Damage Formula ────────────────────────
	// baseDamage = tr(tr(tr(tr(2*L/5 + 2) * BP * A) / D) / 50) + 2
	const level = attacker.level;
	let baseDamage = tr(tr(tr(tr(2 * level / 5 + 2) * basePower * attack) / defense) / 50) + 2;

	// ─── Modifier Chain (modifyDamage order) ────────

	// Step 3: Weather
	baseDamage = applyWeather(baseDamage, moveType, field);

	// Step 4: Critical hit
	if (isCrit) {
		baseDamage = tr(baseDamage * 1.5);
	}

	// Step 5: Random roll — we compute min/max/expected
	const minDamage = tr(tr(baseDamage * 85) / 100);
	const maxDamage = tr(tr(baseDamage * 100) / 100); // = baseDamage
	// Average roll: mean of rolls 85..100 = 92.5
	// But PS does tr(tr(baseDamage * roll) / 100) for each roll, so compute actual average
	let rollSum = 0;
	for (let roll = 85; roll <= 100; roll++) {
		rollSum += tr(tr(baseDamage * roll) / 100);
	}
	let expectedRoll = rollSum / 16;

	// Apply remaining modifiers to all three roll variants
	let minD = minDamage;
	let maxD = maxDamage;
	let expD = expectedRoll;

	// Step 6: STAB
	const stabMult = getSTABMultiplier(attacker, moveType);
	minD = modify(minD, stabMult * 4096, 4096);
	maxD = modify(maxD, stabMult * 4096, 4096);
	// For expected, use floating-point then round
	expD = applyModifyFloat(expD, stabMult);

	// Step 7: Type effectiveness
	// SE: *= 2 per step (no trunc between)
	// NVE: tr(/2) per step
	const typeMod = getTypeMod(moveType, defender, move, attacker);
	minD = applyTypeMod(minD, typeMod);
	maxD = applyTypeMod(maxD, typeMod);
	expD = applyTypeModFloat(expD, typeMod);

	// Step 8: Burn
	if (attacker.status === 'brn' && isPhysical &&
		attacker.abilityId !== 'guts' && move.id !== 'facade') {
		minD = modify(minD, 0.5);
		maxD = modify(maxD, 0.5);
		expD = applyModifyFloat(expD, 0.5);
	}

	// Step 9: Final modifiers (screens, Life Orb, Tinted Lens, etc.)
	const finalMod4096 = getFinalModifier4096(attacker, defender, move, isCrit, typeMod, field, options);
	if (finalMod4096 !== 4096) {
		minD = tr((tr(minD * finalMod4096) + 2047) / 4096);
		maxD = tr((tr(maxD * finalMod4096) + 2047) / 4096);
		expD = expD * finalMod4096 / 4096;
	}

	// Minimum 1 damage (if not immune)
	if (minD < 1) minD = 1;
	if (maxD < 1) maxD = 1;
	if (expD < 1) expD = 1;

	// Multi-hit moves
	let hits = 1;
	if (move.multihit) {
		if (Array.isArray(move.multihit)) {
			if (move.multihit[0] === 2 && move.multihit[1] === 5) {
				// Expected hits: 2*0.35 + 3*0.35 + 4*0.15 + 5*0.15 = 3.1
				if (attacker.abilityId === 'skilllink') {
					hits = 5;
				} else if (attacker.itemId === 'loadeddice') {
					hits = 4.5; // average of 4 and 5
				} else {
					hits = 3.1;
				}
			} else {
				// Average of range
				hits = (move.multihit[0] + move.multihit[1]) / 2;
			}
		} else {
			hits = move.multihit;
		}
	}

	minD = Math.floor(minD * hits);
	maxD = Math.floor(maxD * (Array.isArray(move.multihit) ? (attacker.abilityId === 'skilllink' ? move.multihit[1] : move.multihit[1]) : hits));
	expD = expD * hits;

	return makeDamageResult(minD, maxD, expD, move, defender, effectiveness);
}

/**
 * Calculate damage with crit probability folded in.
 * Returns the expected damage accounting for crit chance.
 */
export function calcDamageWithCrit(
	attacker: MonState,
	defender: MonState,
	move: MoveInfo,
	options: CalcOptions = {}
): DamageResult {
	if (move.category === 'Status') {
		return calcDamage(attacker, defender, move, options);
	}

	const critStage = Math.min(4, Math.max(0, (move.critRatio || 1) - 1));
	// critRatio in MoveInfo: 1 = normal (stage 0), 2 = high crit (stage 1), etc.
	// But PS stores critRatio as the raw value. For most moves, critRatio is 1 (stage 0).
	// High-crit moves have critRatio: 2. We need to map to the crit stage index.
	const critRate = 1 / CRIT_MULT[critStage];

	const normalResult = calcDamage(attacker, defender, move, { ...options, isCrit: false });
	const critResult = calcDamage(attacker, defender, move, { ...options, isCrit: true });

	const blendedExpected = normalResult.expected * (1 - critRate) + critResult.expected * critRate;
	const blendedMin = normalResult.min; // min is always the non-crit low roll
	const blendedMax = critResult.max;   // max is always the crit high roll

	const result = makeDamageResult(blendedMin, blendedMax, blendedExpected, move, defender, normalResult.effectiveness);
	result.expectedWithCrit = blendedExpected;
	result.expectedWithAccuracy = blendedExpected * getAccuracyRate(move, attacker, defender);
	return result;
}

/**
 * Get accuracy rate as a fraction [0, 1].
 */
function getAccuracyRate(move: MoveInfo, attacker: MonState, defender: MonState): number {
	if (move.accuracy === true) return 1;

	// No Guard: all moves hit (both sides)
	if (attacker.abilityId === 'noguard' || defender.abilityId === 'noguard') return 1;

	let acc = move.accuracy;

	// Compound Eyes
	if (attacker.abilityId === 'compoundeyes') {
		acc = Math.min(100, Math.floor(acc * 1.3));
	}
	// Hustle reduces accuracy of physical moves
	if (attacker.abilityId === 'hustle' && move.category === 'Physical') {
		acc = Math.floor(acc * 0.8);
	}
	// Wide Lens
	if (attacker.itemId === 'widelens') {
		acc = Math.min(100, Math.floor(acc * 1.1));
	}

	// Accuracy/evasion boosts
	const accBoost = attacker.boosts.accuracy || 0;
	let evaBoost = defender.boosts.evasion || 0;

	// Mind's Eye / Keen Eye: ignore evasion boosts
	if (attacker.abilityId === 'mindseye' || attacker.abilityId === 'keeneye') {
		if (evaBoost > 0) evaBoost = 0;
	}

	const netBoost = accBoost - evaBoost;

	if (netBoost > 0) {
		acc = Math.floor(acc * (3 + netBoost) / 3);
	} else if (netBoost < 0) {
		acc = Math.floor(acc * 3 / (3 - netBoost));
	}

	return Math.min(1, acc / 100);
}

// ─── Modifier Helpers ────────────────────────────────────────────

function getSTABMultiplier(attacker: MonState, moveType: string): number {
	const hasBaseSTAB = attacker.types.includes(moveType);

	// Tera Stellar: special rules — all types get a one-time boost
	if (attacker.terastallized && attacker.teraType === 'Stellar') {
		// Tera Stellar STAB:
		// - Base type moves: 2.0x (boosted from 1.5x; Adaptability → 2.25x)
		// - Non-base type moves: 1.2x one-time boost (first use per type)
		// We model the "first use" analytically (assume Stellar boost available)
		if (hasBaseSTAB) {
			return attacker.abilityId === 'adaptability' ? 2.25 : 2;
		} else {
			return 1.2;
		}
	}

	const isTeraType = attacker.terastallized && attacker.teraType === moveType;

	// Gen 9 Tera STAB rules:
	// 1. Tera type matches base type → 2.0x (2.25x with Adaptability)
	// 2. Tera type does NOT match base type → 1.5x
	// 3. Base type (non-tera) when terastallized → normal 1.5x STAB
	// 4. No STAB at all → 1.0x

	if (isTeraType) {
		if (hasBaseSTAB) {
			// Tera matches base type: boosted STAB
			return attacker.abilityId === 'adaptability' ? 2.25 : 2;
		} else {
			// Tera into a non-base type: still gets 1.5x STAB
			return attacker.abilityId === 'adaptability' ? 2 : 1.5;
		}
	}

	// Not the tera type — check base STAB
	if (hasBaseSTAB) {
		if (attacker.abilityId === 'adaptability') return 2;
		return 1.5;
	}

	// No STAB
	return 1;
}

/**
 * Get the type modifier as an integer (+1 per SE, -1 per resist).
 */
function getTypeMod(moveType: string, defender: MonState, move: MoveInfo, attacker?: MonState): number {
	let typeMod = 0;
	const dex = getDex();
	const defTypes = getDefensiveTypes(defender);
	// Check if attacker has an ability that negates type immunity
	const ignoresImmunity = attacker ? abilityNegatesImmunity(attacker, defender, moveType) : false;

	for (const defType of defTypes) {
		// Freeze-Dry special case
		if (move.id === 'freezedry' && defType === 'Water') {
			typeMod += 1; // SE instead of resist
			continue;
		}

		// Immunity check (skip if ability negates it)
		if (!dex.getImmunity(moveType, defType)) {
			if (!ignoresImmunity) return -999; // signal immunity
			continue; // Scrappy/Mind's Eye: treat as neutral, skip this type
		}

		const eff = dex.getEffectiveness(moveType, defType);
		typeMod += eff;
	}

	return typeMod;
}

/**
 * Apply type modifier to damage (integer form).
 * SE: multiply by 2 per step (no trunc between).
 * NVE: trunc(/ 2) per step.
 */
function applyTypeMod(damage: number, typeMod: number): number {
	if (typeMod === -999) return 0; // immune
	if (typeMod > 0) {
		for (let i = 0; i < typeMod; i++) {
			damage *= 2;
		}
	} else if (typeMod < 0) {
		for (let i = 0; i > typeMod; i--) {
			damage = tr(damage / 2);
		}
	}
	return damage;
}

/**
 * Float version of type mod for expected value calculations.
 */
function applyTypeModFloat(damage: number, typeMod: number): number {
	if (typeMod === -999) return 0;
	if (typeMod > 0) {
		damage *= Math.pow(2, typeMod);
	} else if (typeMod < 0) {
		damage *= Math.pow(0.5, -typeMod);
	}
	return damage;
}

/**
 * Apply modify() but using floating point for expected value.
 */
function applyModifyFloat(value: number, multiplier: number): number {
	return value * multiplier;
}

function applyWeather(baseDamage: number, moveType: string, field?: FieldState): number {
	if (!field?.weather) return baseDamage;

	const weather = field.weather;

	// Rain: 1.5x Water, 0.5x Fire
	if (weather === 'RainDance' || weather === 'Primordial Sea') {
		if (moveType === 'Water') return modify(baseDamage, 1.5);
		if (moveType === 'Fire' && weather === 'RainDance') return modify(baseDamage, 0.5);
		// Primordial Sea blocks Fire moves entirely (handled elsewhere)
	}

	// Sun: 1.5x Fire, 0.5x Water
	if (weather === 'SunnyDay' || weather === 'Desolate Land') {
		if (moveType === 'Fire') return modify(baseDamage, 1.5);
		if (moveType === 'Water' && weather === 'SunnyDay') return modify(baseDamage, 0.5);
	}

	return baseDamage;
}

/**
 * Get final modifier as 4096-based integer.
 * This combines screens, Life Orb, Tinted Lens, etc.
 */
function getFinalModifier4096(
	attacker: MonState,
	defender: MonState,
	move: MoveInfo,
	isCrit: boolean,
	typeMod: number,
	field?: FieldState,
	options?: CalcOptions
): number {
	let mod = 4096;

	// Screens
	const isPhysical = move.category === 'Physical';
	const screens = getDefenderScreens(defender, field, options);
	if (screens && !isCrit && attacker.abilityId !== 'infiltrator') {
		if (isPhysical && screens.reflect > 0) {
			mod = chainMod(mod, 0.5);
		} else if (!isPhysical && screens.lightscreen > 0) {
			mod = chainMod(mod, 0.5);
		} else if (screens.auroraveil > 0) {
			// Aurora Veil doesn't stack with Reflect/Light Screen
			if (isPhysical && screens.reflect <= 0) {
				mod = chainMod(mod, 0.5);
			} else if (!isPhysical && screens.lightscreen <= 0) {
				mod = chainMod(mod, 0.5);
			}
		}
	}

	// Life Orb: 5324/4096 (~1.3x)
	if (attacker.itemId === 'lifeorb') {
		mod = chainMod(mod, 5324, 4096);
	}

	// Tinted Lens: 2x against resists
	if (attacker.abilityId === 'tintedlens' && typeMod < 0) {
		mod = chainMod(mod, 2);
	}

	// Sniper: 1.5x on crits
	if (attacker.abilityId === 'sniper' && isCrit) {
		mod = chainMod(mod, 1.5);
	}

	// Expert Belt: 1.2x on SE moves
	if (attacker.itemId === 'expertbelt' && typeMod > 0) {
		mod = chainMod(mod, 4915, 4096);
	}

	// ─── Defender Ability Final Modifiers ────────────

	// Multiscale / Shadow Shield: halves damage at full HP
	if ((defender.abilityId === 'multiscale' || defender.abilityId === 'shadowshield') &&
		defender.hp === defender.maxhp) {
		mod = chainMod(mod, 0.5);
	}

	// Filter / Solid Rock / Prism Armor: 0.75x on super-effective moves
	if ((defender.abilityId === 'filter' || defender.abilityId === 'solidrock' || defender.abilityId === 'prismarmor') &&
		typeMod > 0) {
		mod = chainMod(mod, 3072, 4096);
	}

	// Fluffy: halves contact damage, doubles Fire damage taken
	if (defender.abilityId === 'fluffy') {
		if (move.flags && move.flags['contact']) {
			mod = chainMod(mod, 0.5);
		}
		if (move.type === 'Fire') {
			mod = chainMod(mod, 2);
		}
	}

	// Punk Rock (defender): halves sound damage taken
	if (defender.abilityId === 'punkrock' && move.flags && move.flags['sound']) {
		mod = chainMod(mod, 0.5);
	}

	// Thick Fat: halves Fire and Ice damage
	if (defender.abilityId === 'thickfat' && (move.type === 'Fire' || move.type === 'Ice')) {
		mod = chainMod(mod, 0.5);
	}

	// Heatproof: halves Fire damage
	if (defender.abilityId === 'heatproof' && move.type === 'Fire') {
		mod = chainMod(mod, 0.5);
	}

	// Dry Skin: 1.25x Fire damage taken (water immunity handled in checkAbilityImmunity)
	if (defender.abilityId === 'dryskin' && move.type === 'Fire') {
		mod = chainMod(mod, 5120, 4096); // 1.25x
	}

	// Water Bubble (defender): halves Fire damage taken
	if (defender.abilityId === 'waterbubble' && move.type === 'Fire') {
		mod = chainMod(mod, 0.5);
	}

	// Purifying Salt: halves Ghost damage taken
	if (defender.abilityId === 'purifyingsalt' && move.type === 'Ghost') {
		mod = chainMod(mod, 0.5);
	}

	// Type-resist berries (halve SE damage, then consumed)
	// We don't track berry consumption, but can check if defender holds one
	const resistBerry = getResistBerry(defender.itemId, move.type);
	if (resistBerry && typeMod > 0) {
		mod = chainMod(mod, 0.5);
	}

	return mod;
}

function getDefenderScreens(defender: MonState, field?: FieldState, options?: CalcOptions): ScreenState | null {
	if (!field) return null;
	// Determine which side's screens to use
	// If attackerSide is specified, defender is on the opposite side
	if (options?.attackerSide === 'p1') return field.p2Screens;
	if (options?.attackerSide === 'p2') return field.p1Screens;
	// Default: assume defender is p2
	return field.p2Screens;
}

// ─── Base Power Adjustments ──────────────────────────────────────

function adjustBasePower(bp: number, move: MoveInfo, attacker: MonState, defender: MonState): number {
	// Weather Ball: 100 BP and type change in weather (handled by type, here just BP)
	if (move.id === 'weatherball' && bp === 50) {
		// In weather, BP doubles to 100 — but our MoveInfo might already have the base
		// The dex data has basePower 50, it becomes 100 in weather
		// For analytical purposes, we don't change this here (field check is in caller)
	}

	// Knock Off: 1.5x if target has item
	if (move.id === 'knockoff' && defender.itemId) {
		bp = Math.floor(bp * 1.5);
	}

	// Acrobatics: 2x if no item
	if (move.id === 'acrobatics' && !attacker.itemId) {
		bp *= 2;
	}

	// Facade: 2x when burned/poisoned/paralyzed
	if (move.id === 'facade' && attacker.status && ['brn', 'par', 'psn', 'tox'].includes(attacker.status)) {
		bp *= 2;
	}

	// Hex: 2x if target has status
	if (move.id === 'hex' && defender.status) {
		bp *= 2;
	}

	// Avalanche / Revenge: 2x if hit first (we approximate: if we're slower)
	if ((move.id === 'avalanche' || move.id === 'revenge') && move.priority < 0) {
		bp *= 2;
	}

	// Heavy Slam / Heat Crash: BP depends on weight ratio
	if (move.id === 'heavyslam' || move.id === 'heatcrash') {
		const ratio = attacker.weightkg / Math.max(0.1, defender.weightkg);
		if (ratio >= 5) bp = 120;
		else if (ratio >= 4) bp = 100;
		else if (ratio >= 3) bp = 80;
		else if (ratio >= 2) bp = 60;
		else bp = 40;
	}

	// Low Kick / Grass Knot: BP depends on target weight
	if (move.id === 'lowkick' || move.id === 'grassknot') {
		const w = defender.weightkg;
		if (w >= 200) bp = 120;
		else if (w >= 100) bp = 100;
		else if (w >= 50) bp = 80;
		else if (w >= 25) bp = 60;
		else if (w >= 10) bp = 40;
		else bp = 20;
	}

	// Stored Power / Power Trip: 20 + 20 per boost stage
	if (move.id === 'storedpower' || move.id === 'powertrip') {
		let totalBoosts = 0;
		for (const stat of ['atk', 'def', 'spa', 'spd', 'spe'] as const) {
			const b = attacker.boosts[stat];
			if (b > 0) totalBoosts += b;
		}
		bp = 20 + 20 * totalBoosts;
	}

	// Flail / Reversal: BP based on remaining HP percentage
	if (move.id === 'flail' || move.id === 'reversal') {
		const ratio = Math.floor(48 * attacker.hp / attacker.maxhp);
		if (ratio <= 1) bp = 200;
		else if (ratio <= 4) bp = 150;
		else if (ratio <= 9) bp = 100;
		else if (ratio <= 16) bp = 80;
		else if (ratio <= 32) bp = 40;
		else bp = 20;
	}

	// Eruption / Water Spout: BP scales with HP
	if (move.id === 'eruption' || move.id === 'waterspout') {
		bp = Math.max(1, Math.floor(150 * attacker.hp / attacker.maxhp));
	}

	// Gyro Ball: BP = 25 * targetSpeed / userSpeed, capped at 150
	if (move.id === 'gyroball') {
		const userSpeed = Math.max(1, attacker.stats.spe);
		const targetSpeed = Math.max(1, defender.stats.spe);
		bp = Math.min(150, Math.floor(25 * targetSpeed / userSpeed) + 1);
	}

	// Electro Ball: BP based on speed ratio
	if (move.id === 'electroball') {
		const ratio = Math.floor(attacker.stats.spe / Math.max(1, defender.stats.spe));
		if (ratio >= 4) bp = 150;
		else if (ratio >= 3) bp = 120;
		else if (ratio >= 2) bp = 80;
		else bp = 60;
	}

	// Body Press: uses Def instead of Atk (handled in stat section)
	// but BP stays the same

	return bp;
}

// ─── Ability Modifications ───────────────────────────────────────

function applyAbilityBasePower(bp: number, move: MoveInfo, attacker: MonState, _defender: MonState): number {
	// Technician: 1.5x if effective BP <= 60
	if (attacker.abilityId === 'technician' && bp <= 60) {
		bp = Math.floor(bp * 1.5);
	}

	// Sheer Force: ~1.3x if move has secondary effect
	if (attacker.abilityId === 'sheerforce' && (move.secondary || (move.secondaries && move.secondaries.length > 0))) {
		bp = modify(bp, 5325, 4096);
	}

	// Iron Fist: 1.2x for punching moves
	if (attacker.abilityId === 'ironfist' && move.flags && move.flags['punch']) {
		bp = modify(bp, 4915, 4096);
	}

	// Reckless: 1.2x for recoil moves
	if (attacker.abilityId === 'reckless' && move.recoil) {
		bp = modify(bp, 4915, 4096);
	}

	// Strong Jaw: 1.5x for biting moves
	if (attacker.abilityId === 'strongjaw' && move.flags && move.flags['bite']) {
		bp = Math.floor(bp * 1.5);
	}

	// Mega Launcher: 1.5x for pulse/aura moves
	if (attacker.abilityId === 'megalauncher' && move.flags && move.flags['pulse']) {
		bp = Math.floor(bp * 1.5);
	}

	// Tough Claws: 1.3x for contact moves
	if (attacker.abilityId === 'toughclaws' && move.flags && move.flags['contact']) {
		bp = modify(bp, 5325, 4096);
	}

	// Sharpness: 1.5x for slicing moves
	if (attacker.abilityId === 'sharpness' && move.flags && move.flags['slicing']) {
		bp = modify(bp, 6144, 4096);
	}

	// Dragon's Maw: 1.5x for Dragon-type moves
	if (attacker.abilityId === 'dragonsmaw' && move.type === 'Dragon') {
		bp = modify(bp, 6144, 4096);
	}

	// Transistor: 1.3x for Electric-type moves (Gen 9: nerfed from 1.5x to 1.3x)
	if (attacker.abilityId === 'transistor' && move.type === 'Electric') {
		bp = modify(bp, 5325, 4096);
	}

	// Rocky Payload: 1.5x for Rock-type moves
	if (attacker.abilityId === 'rockypayload' && move.type === 'Rock') {
		bp = modify(bp, 6144, 4096);
	}

	// Steely Spirit: 1.5x for Steel-type moves
	if (attacker.abilityId === 'steelyspirit' && move.type === 'Steel') {
		bp = modify(bp, 6144, 4096);
	}

	// Punk Rock: 1.3x for sound moves
	if (attacker.abilityId === 'punkrock' && move.flags && move.flags['sound']) {
		bp = modify(bp, 5325, 4096);
	}

	// Water Bubble: 2x for Water-type moves
	if (attacker.abilityId === 'waterbubble' && move.type === 'Water') {
		bp = modify(bp, 2);
	}

	// Analytic: 1.3x if moving last (we approximate: assume 50% of time moving last)
	// In tree search context, speed comparison would determine this more accurately
	// For now, we flag it but don't apply automatically — the eval/minimax will handle
	// Actually: apply it always as a heuristic since it's a consistent damage boost for slow mons
	if (attacker.abilityId === 'analytic') {
		bp = modify(bp, 5325, 4096);
	}

	// Stakeout: 2x against switching targets (positional — can't determine from static calc)
	// We do NOT apply this by default; it's handled in eval/minimax context

	return bp;
}

function applyAbilityAttackMod(attack: number, attacker: MonState, isPhysical: boolean, field?: FieldState, defender?: MonState): number {
	// Huge Power / Pure Power: 2x Atk
	if ((attacker.abilityId === 'hugepower' || attacker.abilityId === 'purepower') && isPhysical) {
		attack = modify(attack, 2);
	}

	// Hustle: 1.5x Atk (accuracy penalty handled in accuracy calc)
	if (attacker.abilityId === 'hustle' && isPhysical) {
		attack = modify(attack, 1.5);
	}

	// Gorilla Tactics: 1.5x Atk (locked into one move)
	if (attacker.abilityId === 'gorillatactics' && isPhysical) {
		attack = modify(attack, 1.5);
	}

	// Guts: 1.5x Atk when statused
	if (attacker.abilityId === 'guts' && attacker.status && isPhysical) {
		attack = modify(attack, 1.5);
	}

	// Toxic Boost: 1.5x Atk when poisoned
	if (attacker.abilityId === 'toxicboost' && (attacker.status === 'psn' || attacker.status === 'tox') && isPhysical) {
		attack = modify(attack, 1.5);
	}

	// Orichalcum Pulse: 1.3333x Atk in Sun
	if (attacker.abilityId === 'orichalcumpulse' && isPhysical) {
		// Orichalcum Pulse sets Sun on switch-in; boost applies in Sun
		if (field?.weather === 'SunnyDay' || field?.weather === 'Desolate Land') {
			attack = modify(attack, 5461, 4096);
		}
	}

	// Hadron Engine: 1.3333x SpA in Electric Terrain
	if (attacker.abilityId === 'hadronengine' && !isPhysical) {
		if (field?.terrain === 'Electric Terrain') {
			attack = modify(attack, 5461, 4096);
		}
	}

	// Protosynthesis: boost highest stat by 1.3x (1.5x for Speed) in Sun or with Booster Energy
	// We approximate: check if Sun is active or item is Booster Energy
	if (attacker.abilityId === 'protosynthesis') {
		const inSun = field?.weather === 'SunnyDay' || field?.weather === 'Desolate Land';
		const hasBooster = attacker.itemId === 'boosterenergy';
		if (inSun || hasBooster) {
			// Determine highest stat (excluding HP)
			const stats = attacker.stats;
			const highest = getHighestStatName(stats);
			if (isPhysical && highest === 'atk') {
				attack = modify(attack, 5325, 4096); // 1.3x
			} else if (!isPhysical && highest === 'spa') {
				attack = modify(attack, 5325, 4096); // 1.3x
			}
		}
	}

	// Quark Drive: same as Protosynthesis but in Electric Terrain
	if (attacker.abilityId === 'quarkdrive') {
		const inTerrain = field?.terrain === 'Electric Terrain';
		const hasBooster = attacker.itemId === 'boosterenergy';
		if (inTerrain || hasBooster) {
			const stats = attacker.stats;
			const highest = getHighestStatName(stats);
			if (isPhysical && highest === 'atk') {
				attack = modify(attack, 5325, 4096); // 1.3x
			} else if (!isPhysical && highest === 'spa') {
				attack = modify(attack, 5325, 4096); // 1.3x
			}
		}
	}

	// Intrepid Sword: +1 Atk on switch-in (we model as being active if position == 0 and no boosts applied yet)
	// This is tricky — the sim applies this as a boost, so it should already be reflected in mon.boosts.atk
	// No special handling needed here since the boost is captured in extractMonState

	// Supreme Overlord: +10% Atk/SpA per fainted ally (up to +50%)
	// We can't determine fainted allies from a 1v1 context, but in full team context we could
	// For now, skip — this is handled better in the eval layer

	return attack;
}

/**
 * Determine which non-HP stat is highest (for Protosynthesis/Quark Drive).
 */
function getHighestStatName(stats: { atk: number; def: number; spa: number; spd: number; spe: number }): string {
	const entries: [string, number][] = [
		['atk', stats.atk], ['def', stats.def], ['spa', stats.spa],
		['spd', stats.spd], ['spe', stats.spe],
	];
	entries.sort((a, b) => b[1] - a[1]);
	return entries[0][0];
}

function applyAbilityDefenseMod(defense: number, defender: MonState, isPhysical: boolean, field?: FieldState, attacker?: MonState): number {
	// Fur Coat: 2x Def
	if (defender.abilityId === 'furcoat' && isPhysical) {
		defense = modify(defense, 2);
	}

	// Fluffy: halves contact damage (2x Def for contact), but doubles Fire damage
	// The contact half is a defense mod; Fire double is handled in final modifier
	if (defender.abilityId === 'fluffy' && isPhysical) {
		// Check if the attacking move is contact — we need the move info
		// This is imperfect since we don't have move here; handled in getFinalModifier instead
	}

	// Marvel Scale: 1.5x Def when statused
	if (defender.abilityId === 'marvelscale' && defender.status && isPhysical) {
		defense = modify(defense, 1.5);
	}

	// Ice Scales: 0.5x special damage (implemented as 2x SpD)
	if (defender.abilityId === 'icescales' && !isPhysical) {
		defense = modify(defense, 2);
	}

	// Dauntless Shield: +1 Def on switch-in
	// This is applied as a boost by the sim, already captured in mon.boosts.def
	// No special handling needed

	// Sand: 1.5x SpD for Rock types
	if (field?.weather === 'Sandstorm' && !isPhysical && defender.types.includes('Rock')) {
		defense = modify(defense, 1.5);
	}

	// Assault Vest: 1.5x SpD
	if (defender.itemId === 'assaultvest' && !isPhysical) {
		defense = modify(defense, 1.5);
	}

	// Protosynthesis/Quark Drive defense boosts
	if (defender.abilityId === 'protosynthesis') {
		const inSun = field?.weather === 'SunnyDay' || field?.weather === 'Desolate Land';
		const hasBooster = defender.itemId === 'boosterenergy';
		if (inSun || hasBooster) {
			const highest = getHighestStatName(defender.stats);
			if (isPhysical && highest === 'def') {
				defense = modify(defense, 5325, 4096);
			} else if (!isPhysical && highest === 'spd') {
				defense = modify(defense, 5325, 4096);
			}
		}
	}

	if (defender.abilityId === 'quarkdrive') {
		const inTerrain = field?.terrain === 'Electric Terrain';
		const hasBooster = defender.itemId === 'boosterenergy';
		if (inTerrain || hasBooster) {
			const highest = getHighestStatName(defender.stats);
			if (isPhysical && highest === 'def') {
				defense = modify(defense, 5325, 4096);
			} else if (!isPhysical && highest === 'spd') {
				defense = modify(defense, 5325, 4096);
			}
		}
	}

	// Sword of Ruin: reduces all opponents' Def by 25% (attacker has it)
	if (attacker?.abilityId === 'swordofruin' && isPhysical) {
		defense = modify(defense, 3072, 4096); // 0.75x
	}

	// Beads of Ruin: reduces all opponents' SpD by 25% (attacker has it)
	if (attacker?.abilityId === 'beadsofruin' && !isPhysical) {
		defense = modify(defense, 3072, 4096); // 0.75x
	}

	// Tablets of Ruin / Vessel of Ruin — these reduce the OPPONENT'S attack stats
	// They are applied on the attacker side, not here
	// Handled in applyAbilityAttackMod? No — they reduce the OPPONENT's Atk/SpA
	// This means if the DEFENDER has Tablets of Ruin, the attacker's Atk is reduced
	// We handle this here since we have access to defender's ability
	if (defender.abilityId === 'tabletsofruin' && isPhysical) {
		// Reduce attacker's effective damage — modeled as 1.33x defense (equivalent to 0.75x attack)
		defense = modify(defense, 5461, 4096); // ~1.33x def ≈ 0.75x atk
	}
	if (defender.abilityId === 'vesselofruin' && !isPhysical) {
		defense = modify(defense, 5461, 4096); // ~1.33x spd ≈ 0.75x spa
	}

	return defense;
}

// ─── Item Modifications ─────────────────────────────────────────

function applyItemAttackMod(attack: number, attacker: MonState, isPhysical: boolean): number {
	// Choice Band: 1.5x Atk
	if (attacker.itemId === 'choiceband' && isPhysical) {
		attack = modify(attack, 1.5);
	}

	// Choice Specs: 1.5x SpA
	if (attacker.itemId === 'choicespecs' && !isPhysical) {
		attack = modify(attack, 1.5);
	}

	return attack;
}

function applyItemDefenseMod(defense: number, defender: MonState, isPhysical: boolean): number {
	// Eviolite: 1.5x Def and SpD for NFE Pokemon
	if (defender.itemId === 'eviolite') {
		defense = modify(defense, 1.5);
	}

	return defense;
}

// ─── Ability Immunity Checks ─────────────────────────────────────

function checkAbilityImmunity(defender: MonState, moveType: string, move?: MoveInfo): boolean {
	// Levitate: immune to Ground
	if (defender.abilityId === 'levitate' && moveType === 'Ground') return true;

	// Water Absorb / Storm Drain / Dry Skin: immune to Water
	if ((defender.abilityId === 'waterabsorb' || defender.abilityId === 'stormdrain' || defender.abilityId === 'dryskin')
		&& moveType === 'Water') return true;

	// Volt Absorb / Lightning Rod / Motor Drive: immune to Electric
	if ((defender.abilityId === 'voltabsorb' || defender.abilityId === 'lightningrod' || defender.abilityId === 'motordrive')
		&& moveType === 'Electric') return true;

	// Flash Fire: immune to Fire
	if (defender.abilityId === 'flashfire' && moveType === 'Fire') return true;

	// Sap Sipper: immune to Grass
	if (defender.abilityId === 'sapsipper' && moveType === 'Grass') return true;

	// Earth Eater: immune to Ground
	if (defender.abilityId === 'eartheater' && moveType === 'Ground') return true;

	// Well-Baked Body: immune to Fire
	if (defender.abilityId === 'wellbakedbody' && moveType === 'Fire') return true;

	// Wind Rider: immune to wind moves (Tailwind, etc.) — but most damaging wind moves are niche
	// Skipped for now — Wind Rider is primarily about Tailwind boost

	// Soundproof: immune to sound-based moves
	if (defender.abilityId === 'soundproof' && move?.flags && move.flags['sound']) return true;

	// Bulletproof: immune to ball/bomb moves
	if (defender.abilityId === 'bulletproof' && move?.flags && move.flags['bullet']) return true;

	// Overcoat: immune to powder moves (Spore, Sleep Powder, Stun Spore — mostly status)
	// Powder moves are almost all status, so this rarely affects damage calc
	if (defender.abilityId === 'overcoat' && move?.flags && move.flags['powder']) return true;

	// Good as Gold: immune to status moves (already handled by category check, but just in case)
	if (defender.abilityId === 'goodasgold' && move?.category === 'Status') return true;

	return false;
}

/**
 * Check if an attacker's ability negates a type immunity
 * (e.g., Scrappy allows Normal/Fighting to hit Ghost,
 *  Mind's Eye allows Normal/Fighting to hit Ghost and ignores evasion)
 */
function abilityNegatesImmunity(attacker: MonState, _defender: MonState, moveType: string): boolean {
	// Scrappy / Mind's Eye: Normal and Fighting can hit Ghost
	if ((attacker.abilityId === 'scrappy' || attacker.abilityId === 'mindseye')
		&& (moveType === 'Normal' || moveType === 'Fighting')) {
		return true;
	}

	return false;
}

/**
 * Compute type effectiveness ignoring immunities.
 * Used when an ability (Scrappy, Mind's Eye) negates type immunity.
 * Fighting vs Ghost = 1x (neutral, not immune), Normal vs Ghost = 1x.
 */
function getTypeEffectivenessNoImmunity(moveType: string, defTypes: string[]): number {
	const dex = getDex();
	let multiplier = 1;
	for (const defType of defTypes) {
		// Skip immunity — treat as neutral (1x)
		if (!(dex as any).getImmunity(moveType, defType)) continue;
		const eff = (dex as any).getEffectiveness(moveType, defType);
		if (eff > 0) multiplier *= 2;
		else if (eff < 0) multiplier *= 0.5;
	}
	return multiplier;
}

// ─── Type-resist Berries ─────────────────────────────────────────

const RESIST_BERRIES: Record<string, string> = {
	occaberry: 'Fire', passhoberry: 'Water', wacanberry: 'Electric',
	rindoberry: 'Grass', yacheberry: 'Ice', chopleberry: 'Fighting',
	kebiaberry: 'Poison', shucaberry: 'Ground', cobaberry: 'Flying',
	payapaberry: 'Psychic', tangaberry: 'Bug', chartiberry: 'Rock',
	kasibberry: 'Ghost', habanberry: 'Dragon', colburberry: 'Dark',
	babiriberry: 'Steel', roselberry: 'Fairy', chilanberry: 'Normal',
};

function getResistBerry(itemId: string, moveType: string): boolean {
	return RESIST_BERRIES[itemId] === moveType;
}

// ─── Result Builder ──────────────────────────────────────────────

function makeDamageResult(
	min: number, max: number, expected: number,
	move: MoveInfo, defender: MonState, effectiveness: number
): DamageResult {
	const maxhp = defender.maxhp || 1;
	const hp = defender.hp || 0;

	const expectedWithAccuracy = expected * (move.accuracy === true ? 1 : Math.min(1, (move.accuracy || 100) / 100));

	return {
		min: Math.floor(min),
		max: Math.floor(max),
		expected: Math.round(expected * 100) / 100,
		expectedWithAccuracy: Math.round(expectedWithAccuracy * 100) / 100,
		expectedWithCrit: expected, // will be overwritten by calcDamageWithCrit
		percentMin: Math.round(min / maxhp * 10000) / 100,
		percentMax: Math.round(max / maxhp * 10000) / 100,
		percentExpected: Math.round(expected / maxhp * 10000) / 100,
		isOHKO: min >= hp && min > 0,
		turnsToKO: expected > 0 ? Math.ceil(hp / expected) : Infinity,
		moveName: move.name,
		moveType: move.type,
		effectiveness,
	};
}

// ─── Turns-to-KO with Setup ─────────────────────────────────────

/**
 * Calculate turns to KO considering setup moves (e.g., Calm Mind stacking).
 * Models: setup N times, then attack. Finds optimal N.
 *
 * setupBoosts: the boosts gained per use (e.g., { spa: 1, spd: 1 } for Calm Mind)
 * attackMove: the move used to attack after setup
 * recoveryPerTurn: HP the defender recovers per turn (absolute, e.g., Leftovers + Recover)
 */
export function calcSetupTKO(
	attacker: MonState,
	defender: MonState,
	attackMove: MoveInfo,
	setupBoosts: Partial<Record<string, number>>,
	recoveryPerTurn: number,
	options: CalcOptions = {}
): TurnsToKOResult {
	let bestResult: TurnsToKOResult | null = null;

	// Try 0-6 setup turns
	for (let setupTurns = 0; setupTurns <= 6; setupTurns++) {
		// Clone attacker with boosted stats
		const boosted = { ...attacker, boosts: { ...attacker.boosts } };
		for (const [stat, boost] of Object.entries(setupBoosts)) {
			const key = stat as keyof typeof boosted.boosts;
			if (key in boosted.boosts && boost !== undefined) {
				boosted.boosts[key] = Math.min(6, (boosted.boosts[key] || 0) + boost * setupTurns);
			}
		}

		const dmgResult = calcDamageWithCrit(boosted, defender, attackMove, options);
		const damagePerTurn = dmgResult.expectedWithAccuracy;
		const netDamage = damagePerTurn - recoveryPerTurn;

		if (netDamage <= 0) {
			// Can't break through at this boost level
			continue;
		}

		const attackTurns = Math.ceil(defender.hp / netDamage);
		const totalTurns = setupTurns + attackTurns;

		if (!bestResult || totalTurns < bestResult.turnsToKO) {
			bestResult = {
				move: attackMove.id,
				moveName: attackMove.name,
				turnsToKO: totalTurns,
				setupTurns,
				totalDamagePerTurn: damagePerTurn,
				recoveryPerTurn,
				breaksThrough: true,
			};
		}
	}

	if (!bestResult) {
		// Cannot break through at any boost level
		return {
			move: attackMove.id,
			moveName: attackMove.name,
			turnsToKO: Infinity,
			setupTurns: 0,
			totalDamagePerTurn: 0,
			recoveryPerTurn,
			breaksThrough: false,
		};
	}

	return bestResult;
}

// ─── Bulk Damage Calculation ─────────────────────────────────────

/**
 * Calculate damage for all moves an attacker can use against a defender.
 * Returns results sorted by expectedWithCrit (descending).
 */
export function calcAllMoves(
	attacker: MonState,
	defender: MonState,
	options: CalcOptions = {}
): DamageResult[] {
	const results: DamageResult[] = [];

	for (const move of attacker.moves) {
		if (move.disabled) continue;
		if (move.category === 'Status') continue;
		if (move.pp <= 0) continue;

		const result = calcDamageWithCrit(attacker, defender, move, options);
		results.push(result);
	}

	return results.sort((a, b) => b.expectedWithCrit - a.expectedWithCrit);
}

/**
 * Find the best attacking move.
 */
export function bestMove(
	attacker: MonState,
	defender: MonState,
	options: CalcOptions = {}
): DamageResult | null {
	const all = calcAllMoves(attacker, defender, options);
	return all.length > 0 ? all[0] : null;
}
