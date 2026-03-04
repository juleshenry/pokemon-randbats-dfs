/**
 * team-predictor.ts — Shadow team opponent inference
 *
 * Maintains a Bayesian posterior over the 508-species Gen 9 random battle pool.
 * Uses hard constraint elimination from the team generation source code
 * and soft behavioral inference from opponent actions.
 *
 * Key constraints (from data/random-battles/gen9/teams.ts):
 * - Max 2 Pokemon of any single type
 * - Max 3 weak to any type, max 1 double-weak (4x) to any type
 * - Max 4 Freeze-Dry weak
 * - Max 1 level-100 Pokemon (unless adjustLevel)
 * - Max 1 Tera Blast user (including Ogerpon/Terapagos)
 * - Species clause (1 per baseSpecies)
 * - Incompatible pairs (Blissey+Chansey, double web/screen setters, Toxicroak+sun)
 * - Dry Skin/Fluffy count as Fire weakness even if Fire-neutral
 * - Zoroark can't be last slot
 * - MOVE_PAIRS: lightscreen+reflect, sleeptalk+rest, protect+wish, etc.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Dex } = require('../pokemon-showdown/dist/sim');

import type {
	ShadowTeam,
	ShadowTeamSummary,
	RevealedMon,
	CandidateInfo,
	TeamDetails,
	SpeciesEntry,
	SetData,
} from './types';

// ─── Constants ──────────────────────────────────────────────────

const ALL_TYPES = [
	'Bug', 'Dark', 'Dragon', 'Electric', 'Fairy', 'Fighting',
	'Fire', 'Flying', 'Ghost', 'Grass', 'Ground', 'Ice',
	'Normal', 'Poison', 'Psychic', 'Rock', 'Steel', 'Water',
];

const TEAM_SIZE = 6;

/** Limit factor (standard for 6-member teams) */
const LIMIT_FACTOR = 1;

/** Max Pokemon of any single type */
const MAX_TYPE_COUNT = 2 * LIMIT_FACTOR;

/** Max Pokemon weak to any single type */
const MAX_WEAKNESS_COUNT = 3 * LIMIT_FACTOR;

/** Max Pokemon double-weak (4x) to any type */
const MAX_DOUBLE_WEAKNESS = 1 * LIMIT_FACTOR;

/** Max Pokemon weak to Freeze-Dry */
const MAX_FREEZE_DRY_WEAK = 4 * LIMIT_FACTOR;

/** Max level-100 Pokemon */
const MAX_LEVEL_100 = 1 * LIMIT_FACTOR;

/** Behavioral inference multiplier (compounding) */
const BEHAVIORAL_DISCOUNT = 0.7;

/**
 * Incompatible singles pairs.
 * Each entry: [species1[], species2[]] — at most one from each group.
 */
const INCOMPATIBLE_PAIRS: [string[], string[]][] = [
	[['blissey'], ['chansey']],
	[['illumise'], ['volbeat']],
	// Web setters: at most 1
	[
		['ariados', 'smeargle', 'masquerain', 'kricketune', 'leavanny',
			'galvantula', 'vikavolt', 'ribombee', 'araquanid', 'spidops'],
		['ariados', 'smeargle', 'masquerain', 'kricketune', 'leavanny',
			'galvantula', 'vikavolt', 'ribombee', 'araquanid', 'spidops'],
	],
	// Screen setters: at most 1
	[
		['meowstic', 'grimmsnarl', 'ninetalesalola', 'abomasnow'],
		['meowstic', 'grimmsnarl', 'ninetalesalola', 'abomasnow'],
	],
	// Toxicroak incompatible with sun setters
	[['toxicroak'], ['ninetales', 'torkoal', 'groudon', 'koraidon']],
];

/** MOVE_PAIRS: if one is known, the other is very likely */
const MOVE_PAIRS: [string, string][] = [
	['lightscreen', 'reflect'],
	['sleeptalk', 'rest'],
	['protect', 'wish'],
	['leechseed', 'protect'],
	['leechseed', 'substitute'],
];

/** Tera Blast user species (always count as tera blast) */
const TERA_BLAST_SPECIES = new Set(['ogerpon', 'ogerponhearthflame', 'terapagos']);

// ─── Data Loading ───────────────────────────────────────────────

let _setsData: Record<string, SpeciesEntry> | null = null;

function getSetsData(): Record<string, SpeciesEntry> {
	if (!_setsData) {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		_setsData = require('../pokemon-showdown/dist/data/random-battles/gen9/sets.json');
	}
	return _setsData!;
}

/** Get species types from Dex */
function getSpeciesTypes(speciesId: string): string[] {
	const sp = Dex.species.get(speciesId);
	return sp?.types ?? [];
}

/** Get base species (for species clause) */
function getBaseSpecies(speciesId: string): string {
	const sp = Dex.species.get(speciesId);
	return sp?.baseSpecies ?? speciesId;
}

/** Get species name from id */
function getSpeciesName(speciesId: string): string {
	const sp = Dex.species.get(speciesId);
	return sp?.name ?? speciesId;
}

/** Check if a species is weak to a given type */
function isWeakTo(speciesId: string, type: string): boolean {
	const sp = Dex.species.get(speciesId);
	if (!sp) return false;
	return Dex.getImmunity(type, sp) && Dex.getEffectiveness(type, sp) > 0;
}

/** Check if a species is double-weak (4x) to a given type */
function isDoubleWeakTo(speciesId: string, type: string): boolean {
	const sp = Dex.species.get(speciesId);
	if (!sp) return false;
	return Dex.getImmunity(type, sp) && Dex.getEffectiveness(type, sp) > 1;
}

/** Check if a species is weak to Freeze-Dry */
function isWeakToFreezeDry(speciesId: string): boolean {
	const sp = Dex.species.get(speciesId);
	if (!sp) return false;
	const types = sp.types;
	const iceEff = Dex.getImmunity('Ice', sp) ? Dex.getEffectiveness('Ice', sp) : -999;
	// Weak to Freeze-Dry if:
	// - normally weak to Ice (eff > 0), OR
	// - Water-type that doesn't have double Ice resistance (eff > -2)
	return iceEff > 0 || (iceEff > -2 && types.includes('Water'));
}

/** Check if a species has Dry Skin or Fluffy (counts as Fire weakness) */
function hasDrySkinOrFluffy(speciesId: string): boolean {
	const sp = Dex.species.get(speciesId);
	if (!sp) return false;
	const abilities = Object.values(sp.abilities) as string[];
	return abilities.some(a => a === 'Dry Skin' || a === 'Fluffy');
}

/** Check if Fire-neutral species has fire-relevant ability */
function countsAsFireWeak(speciesId: string): boolean {
	const sp = Dex.species.get(speciesId);
	if (!sp) return false;
	const fireEff = Dex.getImmunity('Fire', sp) ? Dex.getEffectiveness('Fire', sp) : -999;
	if (fireEff !== 0) return false; // only for Fire-neutral species
	return hasDrySkinOrFluffy(speciesId);
}

// ─── Shadow Team Initialization ─────────────────────────────────

/**
 * Create an initial shadow team with all 508 species as candidates.
 * Call this at battle start before any mons are revealed.
 */
export function createShadowTeam(): ShadowTeam {
	const setsData = getSetsData();
	const candidates = new Map<string, CandidateInfo>();
	let totalWeight = 0;

	for (const [speciesId, entry] of Object.entries(setsData)) {
		const types = getSpeciesTypes(speciesId);
		const info: CandidateInfo = {
			speciesId,
			species: getSpeciesName(speciesId),
			types,
			level: entry.level,
			weight: 1.0, // uniform prior
			sets: entry.sets,
		};
		candidates.set(speciesId, info);
		totalWeight += 1.0;
	}

	return {
		revealed: [],
		candidates,
		totalWeight,
		typeCount: {},
		weaknessCount: {},
		doubleWeaknessCount: {},
		freezeDryWeakCount: 0,
		hasTeraBlastUser: false,
		hasLevel100: false,
		baseFormesSeen: new Set(),
		teamDetails: emptyTeamDetails(),
		slotsRemaining: TEAM_SIZE,
	};
}

function emptyTeamDetails(): TeamDetails {
	return {
		rain: 0, sun: 0, sand: 0, snow: 0,
		stealthRock: 0, spikes: 0, toxicSpikes: 0, stickyWeb: 0,
		defog: 0, rapidSpin: 0, screens: 0, statusCure: 0, teraBlast: 0,
	};
}

// ─── Reveal & Update ────────────────────────────────────────────

/**
 * Reveal an opponent's Pokemon. Updates the shadow team by:
 * 1. Moving the species from candidates to revealed
 * 2. Updating type/weakness/constraint counters
 * 3. Eliminating impossible candidates via hard constraints
 *
 * @param shadow - Current shadow team state
 * @param speciesId - The species ID (e.g., 'garchomp')
 * @param level - The level of the revealed mon
 * @param ability - The ability (if known)
 * @param knownMoves - Moves revealed so far
 * @param item - Item if known
 * @param teraType - Tera type if revealed
 * @param fainted - Whether the mon has fainted
 * @returns Updated shadow team (mutates in place)
 */
export function revealMon(
	shadow: ShadowTeam,
	speciesId: string,
	level: number,
	ability: string = '',
	knownMoves: string[] = [],
	item: string | null = null,
	teraType: string | null = null,
	fainted: boolean = false,
): ShadowTeam {
	// Normalize speciesId
	speciesId = Dex.species.get(speciesId)?.id ?? speciesId;

	// Check if already revealed (update existing entry)
	const existing = shadow.revealed.find(r => r.speciesId === speciesId);
	if (existing) {
		return updateRevealedMon(shadow, speciesId, ability, knownMoves, item, teraType, fainted);
	}

	const types = getSpeciesTypes(speciesId);
	const baseSpecies = getBaseSpecies(speciesId);
	const setsData = getSetsData();
	// Look up sets: try exact id first, then fall back to base species id
	// (e.g., 'mausholdfour' → 'maushold' in sets.json)
	const baseId = Dex.species.get(baseSpecies)?.id ?? speciesId;
	const entry = setsData[speciesId] ?? setsData[baseId];

	// Narrow possible sets based on known moves
	let possibleSets = entry?.sets ?? [];
	if (knownMoves.length > 0) {
		possibleSets = narrowSets(possibleSets, knownMoves, ability);
	}

	// Infer full moveset if deterministic
	let inferredMoveset: string[] | null = null;
	if (possibleSets.length === 1 && possibleSets[0].movepool.length === 4) {
		inferredMoveset = possibleSets[0].movepool.map(m => Dex.moves.get(m).id);
	}

	const revealed: RevealedMon = {
		species: getSpeciesName(speciesId),
		speciesId,
		level,
		ability,
		knownMoves: knownMoves.map(m => Dex.moves.get(m).id),
		possibleSets,
		inferredMoveset,
		item,
		teraType,
		types,
		fainted,
	};

	shadow.revealed.push(revealed);
	shadow.slotsRemaining = TEAM_SIZE - shadow.revealed.length;

	// Remove from candidates (both exact ID and base species forms)
	if (shadow.candidates.has(speciesId)) {
		shadow.totalWeight -= shadow.candidates.get(speciesId)!.weight;
		shadow.candidates.delete(speciesId);
	}
	// Also remove base species entry if different from speciesId
	if (baseId !== speciesId && shadow.candidates.has(baseId)) {
		shadow.totalWeight -= shadow.candidates.get(baseId)!.weight;
		shadow.candidates.delete(baseId);
	}

	// Update counters
	for (const type of types) {
		shadow.typeCount[type] = (shadow.typeCount[type] || 0) + 1;
	}
	for (const type of ALL_TYPES) {
		if (isWeakTo(speciesId, type)) {
			shadow.weaknessCount[type] = (shadow.weaknessCount[type] || 0) + 1;
		}
		if (isDoubleWeakTo(speciesId, type)) {
			shadow.doubleWeaknessCount[type] = (shadow.doubleWeaknessCount[type] || 0) + 1;
		}
	}
	// Dry Skin/Fluffy fire weakness (check actual ability if known)
	if (ability && ['Dry Skin', 'Fluffy'].includes(ability)) {
		const sp = Dex.species.get(speciesId);
		const fireEff = sp ? (Dex.getImmunity('Fire', sp) ? Dex.getEffectiveness('Fire', sp) : -999) : -999;
		if (fireEff === 0) {
			shadow.weaknessCount['Fire'] = (shadow.weaknessCount['Fire'] || 0) + 1;
		}
	}
	if (isWeakToFreezeDry(speciesId)) {
		shadow.freezeDryWeakCount++;
	}
	if (level === 100) {
		shadow.hasLevel100 = true;
	}
	shadow.baseFormesSeen.add(baseSpecies);

	// Check tera blast
	for (const set of possibleSets) {
		if (set.role === 'Tera Blast user') {
			shadow.hasTeraBlastUser = true;
			break;
		}
	}
	if (TERA_BLAST_SPECIES.has(speciesId)) {
		shadow.hasTeraBlastUser = true;
	}

	// Update teamDetails from known moves and ability
	updateTeamDetails(shadow.teamDetails, knownMoves.map(m => Dex.moves.get(m).id), ability);

	// Apply hard constraint elimination
	applyHardConstraints(shadow);

	return shadow;
}

/**
 * Update an already-revealed mon with new info (move reveals, ability, item).
 */
function updateRevealedMon(
	shadow: ShadowTeam,
	speciesId: string,
	ability: string,
	newMoves: string[],
	item: string | null,
	teraType: string | null,
	fainted: boolean,
): ShadowTeam {
	const mon = shadow.revealed.find(r => r.speciesId === speciesId);
	if (!mon) return shadow;

	if (ability && !mon.ability) mon.ability = ability;
	if (item && !mon.item) mon.item = item;
	if (teraType && !mon.teraType) mon.teraType = teraType;
	if (fainted) mon.fainted = fainted;

	// Add newly revealed moves
	const normalizedNew = newMoves.map(m => Dex.moves.get(m).id);
	const prevMoveCount = mon.knownMoves.length;
	for (const m of normalizedNew) {
		if (!mon.knownMoves.includes(m)) {
			mon.knownMoves.push(m);
		}
	}

	// Re-narrow sets if new info
	if (mon.knownMoves.length > prevMoveCount || (ability && !mon.ability)) {
		const setsData = getSetsData();
		const entry = setsData[speciesId];
		if (entry) {
			mon.possibleSets = narrowSets(entry.sets, mon.knownMoves, mon.ability);
			if (mon.possibleSets.length === 1 && mon.possibleSets[0].movepool.length === 4) {
				mon.inferredMoveset = mon.possibleSets[0].movepool.map(m => Dex.moves.get(m).id);
			}
		}
	}

	// Update teamDetails with new moves
	const addedMoves = normalizedNew.filter(m => !mon.knownMoves.slice(0, prevMoveCount).includes(m));
	if (addedMoves.length > 0) {
		updateTeamDetails(shadow.teamDetails, addedMoves, ability);
	}

	return shadow;
}

/**
 * Narrow possible sets based on known moves and ability.
 */
function narrowSets(sets: SetData[], knownMoves: string[], ability: string): SetData[] {
	const normalizedMoves = knownMoves.map(m => Dex.moves.get(m).id);

	return sets.filter(set => {
		// Check if all known moves are in this set's movepool
		const poolIds = set.movepool.map(m => Dex.moves.get(m).id);
		for (const m of normalizedMoves) {
			if (!poolIds.includes(m)) return false;
		}
		// Check ability compatibility
		if (ability) {
			const abilityId = Dex.abilities.get(ability).id;
			const setAbilityIds = set.abilities.map(a => Dex.abilities.get(a).id);
			if (!setAbilityIds.includes(abilityId)) return false;
		}
		return true;
	});
}

/**
 * Update teamDetails based on revealed moves and ability.
 */
function updateTeamDetails(td: TeamDetails, moves: string[], ability: string): void {
	const abilityId = ability ? Dex.abilities.get(ability)?.id ?? '' : '';

	if (abilityId === 'drizzle' || moves.includes('raindance')) td.rain = 1;
	if (abilityId === 'drought' || abilityId === 'orichalcumpulse' || moves.includes('sunnyday')) td.sun = 1;
	if (abilityId === 'sandstream') td.sand = 1;
	if (abilityId === 'snowwarning' || moves.includes('snowscape') || moves.includes('chillyreception')) td.snow = 1;

	if (moves.includes('stealthrock') || moves.includes('stoneaxe')) td.stealthRock = 1;
	if (moves.includes('spikes') || moves.includes('ceaselessedge')) td.spikes = (td.spikes || 0) + 1;
	if (moves.includes('toxicspikes') || abilityId === 'toxicdebris') td.toxicSpikes = 1;
	if (moves.includes('stickyweb')) td.stickyWeb = 1;
	if (moves.includes('defog')) td.defog = 1;
	if (moves.includes('rapidspin') || moves.includes('mortalspin')) td.rapidSpin = 1;
	if (moves.includes('healbell')) td.statusCure = 1;
	if (moves.includes('auroraveil') || (moves.includes('reflect') && moves.includes('lightscreen'))) {
		td.screens = 1;
	}
}

// ─── Hard Constraint Elimination ────────────────────────────────

/**
 * Remove candidates that violate team-building constraints.
 * Called after each reveal.
 */
function applyHardConstraints(shadow: ShadowTeam): void {
	if (shadow.slotsRemaining <= 0) {
		// No slots left, remove all candidates
		shadow.candidates.clear();
		shadow.totalWeight = 0;
		return;
	}

	const toRemove: string[] = [];

	for (const [speciesId, candidate] of shadow.candidates) {
		if (isConstraintViolation(shadow, speciesId, candidate)) {
			toRemove.push(speciesId);
		}
	}

	for (const id of toRemove) {
		shadow.totalWeight -= shadow.candidates.get(id)!.weight;
		shadow.candidates.delete(id);
	}
}

/**
 * Check if adding a candidate would violate any team-building constraint.
 */
function isConstraintViolation(shadow: ShadowTeam, speciesId: string, candidate: CandidateInfo): boolean {
	// Species clause: base species already on team
	const baseSpecies = getBaseSpecies(speciesId);
	if (shadow.baseFormesSeen.has(baseSpecies)) return true;

	// Type limit: max 2 of any type
	for (const type of candidate.types) {
		if ((shadow.typeCount[type] || 0) >= MAX_TYPE_COUNT) return true;
	}

	// Weakness limits
	for (const type of ALL_TYPES) {
		if (isWeakTo(speciesId, type)) {
			if ((shadow.weaknessCount[type] || 0) >= MAX_WEAKNESS_COUNT) return true;
		}
		if (isDoubleWeakTo(speciesId, type)) {
			if ((shadow.doubleWeaknessCount[type] || 0) >= MAX_DOUBLE_WEAKNESS) return true;
		}
	}

	// Dry Skin/Fluffy fire weakness check
	// Conservative: if species CAN have Dry Skin/Fluffy and is Fire-neutral, check fire limit
	if (countsAsFireWeak(speciesId)) {
		if ((shadow.weaknessCount['Fire'] || 0) >= MAX_WEAKNESS_COUNT) return true;
	}

	// Freeze-Dry weakness limit
	if (isWeakToFreezeDry(speciesId)) {
		if (shadow.freezeDryWeakCount >= MAX_FREEZE_DRY_WEAK) return true;
	}

	// Level 100 limit
	if (candidate.level === 100 && shadow.hasLevel100) return true;

	// Tera Blast limit
	if (shadow.hasTeraBlastUser) {
		if (TERA_BLAST_SPECIES.has(speciesId)) return true;
		// Check if ALL sets for this species are Tera Blast user role
		const allTera = candidate.sets.every(s => s.role === 'Tera Blast user');
		if (allTera) return true;
	}

	// Zoroark can't be last slot
	if (baseSpecies === 'Zoroark' && shadow.slotsRemaining <= 1) return true;

	// Incompatible pairs
	for (const [group1, group2] of INCOMPATIBLE_PAIRS) {
		const revealedIds = shadow.revealed.map(r => r.speciesId);
		const inGroup1 = revealedIds.some(id => group1.includes(id));
		const inGroup2 = revealedIds.some(id => group2.includes(id));

		// If a revealed mon is in group1, candidates in group2 are excluded (and vice versa)
		if (inGroup1 && group2.includes(speciesId)) return true;
		if (inGroup2 && group1.includes(speciesId)) return true;

		// Special case: same-group incompatibility (e.g., web setters)
		if (group1 === group2 || JSON.stringify(group1) === JSON.stringify(group2)) {
			if (inGroup1 && group1.includes(speciesId)) return true;
		}
	}

	return false;
}

// ─── Behavioral Inference ───────────────────────────────────────

/**
 * Apply a soft behavioral signal to the shadow team.
 * Reduces the probability of specific candidates by a compounding multiplier.
 *
 * Example signals:
 * - Opponent switches suboptimally: reduce probability of better alternatives
 * - Opponent doesn't switch to a type advantage: reduce probability of that type
 *
 * @param shadow - Shadow team to update
 * @param filterFn - Function that returns true for candidates to discount
 * @param multiplier - How much to reduce (default 0.7, compounding)
 */
export function applyBehavioralSignal(
	shadow: ShadowTeam,
	filterFn: (candidate: CandidateInfo) => boolean,
	multiplier: number = BEHAVIORAL_DISCOUNT,
): ShadowTeam {
	for (const [, candidate] of shadow.candidates) {
		if (filterFn(candidate)) {
			const oldWeight = candidate.weight;
			candidate.weight *= multiplier;
			shadow.totalWeight += (candidate.weight - oldWeight);
		}
	}
	return shadow;
}

/**
 * Signal: opponent didn't switch to a type that resists our active mon's STAB.
 * Slightly reduces the probability of unrevealed mons with that typing.
 */
export function signalNoSwitch(
	shadow: ShadowTeam,
	resistType: string,
): ShadowTeam {
	return applyBehavioralSignal(
		shadow,
		(c) => {
			const sp = Dex.species.get(c.speciesId);
			if (!sp) return false;
			const eff = Dex.getImmunity(resistType, sp) ? Dex.getEffectiveness(resistType, sp) : -999;
			return eff < 0; // resists the type
		},
		BEHAVIORAL_DISCOUNT,
	);
}

/**
 * Signal: opponent used a move that reveals information about their set.
 * If a revealed mon used a move from a MOVE_PAIR, increase confidence
 * that the partner move is also in their moveset.
 */
export function inferMovePairs(shadow: ShadowTeam, speciesId: string, moveId: string): void {
	const mon = shadow.revealed.find(r => r.speciesId === speciesId);
	if (!mon) return;

	const normalizedMove = Dex.moves.get(moveId).id;
	for (const [m1, m2] of MOVE_PAIRS) {
		if (normalizedMove === m1 && !mon.knownMoves.includes(m2)) {
			// Partner move is likely — check if any possible set includes both
			const pairSets = mon.possibleSets.filter(s => {
				const pool = s.movepool.map(m => Dex.moves.get(m).id);
				return pool.includes(m1) && pool.includes(m2);
			});
			if (pairSets.length > 0) {
				mon.possibleSets = pairSets;
				if (pairSets.length === 1 && pairSets[0].movepool.length === 4) {
					mon.inferredMoveset = pairSets[0].movepool.map(m => Dex.moves.get(m).id);
				}
			}
		}
		if (normalizedMove === m2 && !mon.knownMoves.includes(m1)) {
			const pairSets = mon.possibleSets.filter(s => {
				const pool = s.movepool.map(m => Dex.moves.get(m).id);
				return pool.includes(m1) && pool.includes(m2);
			});
			if (pairSets.length > 0) {
				mon.possibleSets = pairSets;
				if (pairSets.length === 1 && pairSets[0].movepool.length === 4) {
					mon.inferredMoveset = pairSets[0].movepool.map(m => Dex.moves.get(m).id);
				}
			}
		}
	}
}

// ─── Query Functions ────────────────────────────────────────────

/**
 * Get probability of a specific species being on the team.
 */
export function getSpeciesProbability(shadow: ShadowTeam, speciesId: string): number {
	const candidate = shadow.candidates.get(speciesId);
	if (!candidate || shadow.totalWeight <= 0) return 0;
	// Probability per slot, then 1 - P(not picked in any remaining slot)
	// Simplified: weight / totalWeight * slotsRemaining (capped at 1)
	const perSlot = candidate.weight / shadow.totalWeight;
	return Math.min(1, perSlot * shadow.slotsRemaining);
}

/**
 * Get probability that the opponent has at least one Pokemon of a given type.
 */
export function getTypeProbability(shadow: ShadowTeam, type: string): number {
	if (shadow.revealed.some(r => r.types.includes(type) && !r.fainted)) return 1;

	let typeWeight = 0;
	for (const [, candidate] of shadow.candidates) {
		if (candidate.types.includes(type)) {
			typeWeight += candidate.weight;
		}
	}
	if (shadow.totalWeight <= 0) return 0;
	const perSlot = typeWeight / shadow.totalWeight;
	return 1 - Math.pow(1 - perSlot, shadow.slotsRemaining);
}

/**
 * Get the top N most likely unrevealed candidates.
 */
export function getTopCandidates(shadow: ShadowTeam, n: number = 10): CandidateInfo[] {
	const sorted = Array.from(shadow.candidates.values())
		.sort((a, b) => b.weight - a.weight);
	return sorted.slice(0, n);
}

/**
 * Get the candidates that are threats to a specific Pokemon.
 * A threat is a candidate that:
 * - Has STAB moves super-effective against the target
 * - Is faster or has priority
 * - Has high probability of being on the team
 */
export function getThreats(
	shadow: ShadowTeam,
	targetTypes: string[],
	targetSpeciesId?: string,
): { species: string; probability: number; reason: string }[] {
	const threats: { species: string; probability: number; reason: string }[] = [];

	for (const [speciesId, candidate] of shadow.candidates) {
		const prob = getSpeciesProbability(shadow, speciesId);
		if (prob < 0.01) continue; // skip very unlikely

		const reasons: string[] = [];

		// Check if candidate's STAB types are SE against target
		for (const type of candidate.types) {
			let totalEff = 0;
			for (const defType of targetTypes) {
				const eff = Dex.getEffectiveness(type, { types: [defType] });
				totalEff += eff;
			}
			const immune = !Dex.getImmunity(type, { types: targetTypes });
			if (!immune && totalEff > 0) {
				reasons.push(`STAB ${type} SE`);
			}
		}

		if (reasons.length > 0) {
			threats.push({
				species: candidate.species,
				probability: prob,
				reason: reasons.join(', '),
			});
		}
	}

	// Sort by probability * threat level
	threats.sort((a, b) => b.probability - a.probability);
	return threats.slice(0, 15);
}

/**
 * Identify notable absences in the remaining candidates.
 * E.g., "No Water resist likely" if all Water-resists are eliminated.
 */
export function getNotableAbsences(shadow: ShadowTeam): string[] {
	const absences: string[] = [];

	// Check if any type has very low remaining coverage
	for (const type of ALL_TYPES) {
		let resistWeight = 0;
		for (const [speciesId, candidate] of shadow.candidates) {
			const sp = Dex.species.get(speciesId);
			if (!sp) continue;
			const eff = Dex.getImmunity(type, sp) ? Dex.getEffectiveness(type, sp) : -999;
			if (eff < 0 || !Dex.getImmunity(type, sp)) {
				resistWeight += candidate.weight;
			}
		}
		const resistProb = shadow.totalWeight > 0 ? resistWeight / shadow.totalWeight : 0;
		const anySlotProb = 1 - Math.pow(1 - resistProb, shadow.slotsRemaining);

		if (anySlotProb < 0.15 && shadow.slotsRemaining > 0) {
			absences.push(`No ${type} resist likely (${(anySlotProb * 100).toFixed(0)}%)`);
		}
	}

	return absences;
}

// ─── Summary Generation ─────────────────────────────────────────

/**
 * Generate a complete shadow team summary for the dense plan output.
 */
export function getShadowTeamSummary(shadow: ShadowTeam): ShadowTeamSummary {
	const topCandidates = getTopCandidates(shadow, 8).map(c => ({
		species: c.species,
		probability: getSpeciesProbability(shadow, c.speciesId),
		types: c.types,
	}));

	// Likely unrevealed types
	const likelyTypes: { type: string; probability: number }[] = [];
	for (const type of ALL_TYPES) {
		const prob = getTypeProbability(shadow, type);
		if (prob > 0.1 && !shadow.revealed.some(r => r.types.includes(type))) {
			likelyTypes.push({ type, probability: prob });
		}
	}
	likelyTypes.sort((a, b) => b.probability - a.probability);

	// Get threats relative to revealed team (simplified: use first non-fainted mon)
	const activeRevealed = shadow.revealed.find(r => !r.fainted);
	const threats = activeRevealed
		? getThreats(shadow, activeRevealed.types, activeRevealed.speciesId)
		: [];

	const absences = getNotableAbsences(shadow);

	return {
		slotsRemaining: shadow.slotsRemaining,
		topCandidates,
		likelyTypes,
		threats,
		absences,
	};
}

/**
 * Format the shadow team summary as a string for CLI output.
 */
export function formatShadowTeamSummary(summary: ShadowTeamSummary): string {
	const lines: string[] = [];

	lines.push(`Shadow Team Intelligence (${summary.slotsRemaining} slots unrevealed):`);

	if (summary.topCandidates.length > 0) {
		lines.push('  Top candidates:');
		for (const c of summary.topCandidates.slice(0, 5)) {
			lines.push(`    ${c.species} [${c.types.join('/')}] (${(c.probability * 100).toFixed(1)}%)`);
		}
	}

	if (summary.likelyTypes.length > 0) {
		const typeStrs = summary.likelyTypes.slice(0, 5).map(
			t => `${t.type} ${(t.probability * 100).toFixed(0)}%`
		);
		lines.push(`  Likely unrevealed types: ${typeStrs.join(', ')}`);
	}

	if (summary.threats.length > 0) {
		lines.push('  Key threats:');
		for (const t of summary.threats.slice(0, 3)) {
			lines.push(`    ${t.species} (${(t.probability * 100).toFixed(1)}%) — ${t.reason}`);
		}
	}

	if (summary.absences.length > 0) {
		lines.push(`  Gaps: ${summary.absences.join('; ')}`);
	}

	return lines.join('\n');
}
