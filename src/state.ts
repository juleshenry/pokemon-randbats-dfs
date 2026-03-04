/**
 * state.ts — Battle state management for DFS/minimax search
 *
 * Wraps the PS sim's battle cloning, choice enumeration, and state extraction.
 * This is the interface between the raw sim and our analytical modules.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Sim = require('../pokemon-showdown/dist/sim');
const SimBattle = Sim.Battle;
const SimDex = Sim.Dex;
const SimTeams = Sim.Teams;

import type {
	Battle, FieldState, HazardState, ScreenState, MonState, MoveInfo, Choice, StatsTable, BoostTable,
} from './types';

// ─── Battle Creation ─────────────────────────────────────────────

/**
 * Create a 1v1 battle with explicit Pokemon sets.
 * Sets are normalized to random battle EVs (85 across) and levels from sets.json.
 */
export function create1v1Battle(
	p1Set: Record<string, any>,
	p2Set: Record<string, any>,
	options: { seed?: [number, number, number, number] } = {}
): Battle {
	const seed = options.seed || [1, 2, 3, 4];

	// Normalize sets to random battle standards
	const norm1 = normalizeSet(p1Set);
	const norm2 = normalizeSet(p2Set);

	const t1 = SimTeams.pack([norm1]);
	const t2 = SimTeams.pack([norm2]);

	const battle = new SimBattle({
		formatid: 'gen9customgame@@@!Team Preview,!Cancel Mod',
		seed,
		p1: { name: 'P1', team: t1 },
		p2: { name: 'P2', team: t2 },
	});
	battle.send = () => {};
	return battle as Battle;
}

/**
 * Create a battle with full teams (2-6 Pokemon per side).
 */
export function createBattle(
	p1Team: Record<string, any>[],
	p2Team: Record<string, any>[],
	options: { seed?: [number, number, number, number]; format?: string } = {}
): Battle {
	const seed = options.seed || [1, 2, 3, 4];
	const format = options.format || 'gen9customgame@@@!Team Preview,!Cancel Mod';

	const t1 = SimTeams.pack(p1Team.map(normalizeSet));
	const t2 = SimTeams.pack(p2Team.map(normalizeSet));

	const battle = new SimBattle({
		formatid: format,
		seed,
		p1: { name: 'P1', team: t1 },
		p2: { name: 'P2', team: t2 },
	});
	battle.send = () => {};
	return battle as Battle;
}

/**
 * Create a random battle with generated teams.
 */
export function createRandomBattle(
	seed: [number, number, number, number] = [1, 2, 3, 4]
): Battle {
	const t1 = SimTeams.pack(SimTeams.generate('gen9randombattle', { seed: [seed[0], seed[1], 0, 0] }));
	const t2 = SimTeams.pack(SimTeams.generate('gen9randombattle', { seed: [seed[2], seed[3], 0, 0] }));

	const battle = new SimBattle({
		formatid: 'gen9randombattle',
		seed,
		p1: { name: 'P1', team: t1 },
		p2: { name: 'P2', team: t2 },
	});
	battle.send = () => {};
	return battle as Battle;
}

/**
 * Normalize a partial Pokemon set to random battle standards.
 */
function normalizeSet(set: Record<string, any>): Record<string, any> {
	const species = SimDex.species.get(set.species);
	const level = set.level || getRandomBattleLevel(species);

	return {
		name: set.name || species.name,
		species: set.species,
		item: set.item || '',
		ability: set.ability || Object.values(species.abilities)[0],
		moves: set.moves || [],
		nature: set.nature || '',
		evs: set.evs || { hp: 85, atk: 85, def: 85, spa: 85, spd: 85, spe: 85 },
		ivs: set.ivs || { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
		level,
		gender: set.gender || '',
		teraType: set.teraType || species.types[0],
	};
}

/**
 * Look up the random battle level for a species from sets.json.
 * Falls back to tier-based scaling.
 */
function getRandomBattleLevel(species: any): number {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const setsData = require('../pokemon-showdown/dist/data/random-battles/gen9/sets.json');
		const speciesId = SimDex.toID(species.name);
		if (setsData[speciesId]?.level) return setsData[speciesId].level;
	} catch {
		// fallback
	}

	// Tier-based fallback
	const tierScale: Record<string, number> = {
		Uber: 76, OU: 80, UUBL: 81, UU: 82, RUBL: 83, RU: 84,
		NUBL: 85, NU: 86, PUBL: 87, PU: 88, NFE: 88,
	};
	return tierScale[species.tier] || 80;
}

// ─── Battle Cloning ──────────────────────────────────────────────

/**
 * Clone a battle state for tree search. Returns an independent copy.
 */
export function cloneBattle(battle: Battle): Battle {
	const json = (battle as any).toJSON();
	const clone = SimBattle.fromJSON(json);
	clone.restart(() => {});
	// Reset log position to prevent "Infinite loop" error from log length check.
	// The sim throws when (log.length - sentLogPos > 1000), so we mark all
	// existing log entries as "sent" by setting sentLogPos to current log length.
	clone.sentLogPos = clone.log.length;
	return clone as Battle;
}

// ─── Choice Enumeration ─────────────────────────────────────────

/**
 * Get all legal choices for a side.
 * Returns an array of Choice objects with both the PS format string
 * and a human-readable label.
 */
export function getChoices(battle: Battle, sideIndex: number): Choice[] {
	const side = (battle as any).sides[sideIndex];
	const req = side.activeRequest;
	const choices: Choice[] = [];

	if (!req || req.wait) return choices;

	if (req.forceSwitch) {
		// Must switch: iterate valid switch targets
		const pokemon = req.side.pokemon;
		for (let i = 0; i < pokemon.length; i++) {
			const p = pokemon[i];
			if (p.active) continue;
			if (p.condition.endsWith(' fnt')) continue;
			choices.push({
				choiceString: `switch ${i + 1}`,
				label: `Switch to ${p.ident.split(': ')[1] || p.details.split(',')[0]}`,
				type: 'switch',
				switchIndex: i + 1,
			});
		}
		return choices;
	}

	if (req.active) {
		const active = req.active[0];
		const pokemon = req.side.pokemon;
		const moves = active.moves;
		const canTerastallize = active.canTerastallize;

		// Move choices
		for (let i = 0; i < moves.length; i++) {
			const m = moves[i];
			if (m.disabled) continue;

			choices.push({
				choiceString: `move ${i + 1}`,
				label: m.move,
				type: 'move',
				moveIndex: i,
			});

			// Terastallize variants
			if (canTerastallize) {
				choices.push({
					choiceString: `move ${i + 1} terastallize`,
					label: `${m.move} + Tera`,
					type: 'move',
					moveIndex: i,
					terastallize: true,
				});
			}
		}

		// Switch choices (unless trapped)
		if (!active.trapped) {
			for (let i = 0; i < pokemon.length; i++) {
				const p = pokemon[i];
				if (p.active) continue;
				if (p.condition.endsWith(' fnt')) continue;
				choices.push({
					choiceString: `switch ${i + 1}`,
					label: `Switch to ${p.ident.split(': ')[1] || p.details.split(',')[0]}`,
					type: 'switch',
					switchIndex: i + 1,
				});
			}
		}
	}

	// Fallback: if somehow no choices, return default
	if (choices.length === 0) {
		choices.push({
			choiceString: 'default',
			label: 'Default',
			type: 'move',
		});
	}

	return choices;
}

// ─── Terminal Check ──────────────────────────────────────────────

export function isTerminal(battle: Battle): boolean {
	return (battle as any).ended;
}

export function getWinner(battle: Battle): string | null {
	if (!(battle as any).ended) return null;
	return (battle as any).winner || null;
}

/**
 * Returns +1 if P1 won, -1 if P2 won, 0 for tie, null if not ended.
 */
export function getWinValue(battle: Battle, playerName?: string): number | null {
	if (!(battle as any).ended) return null;
	const winner = (battle as any).winner;
	if (!winner) return 0; // tie
	if (playerName) return winner === playerName ? 1 : -1;
	// Default: P1 perspective
	return winner === (battle as any).sides[0].name ? 1 : -1;
}

// ─── Field State Extraction ─────────────────────────────────────

export function extractFieldState(battle: Battle): FieldState {
	const b = battle as any;
	const field = b.field;

	return {
		weather: field.weather || null,
		weatherTurns: field.weatherState?.duration || 0,
		terrain: field.terrain || null,
		terrainTurns: field.terrainState?.duration || 0,
		trickRoom: field.pseudoWeather?.trickroom?.duration || 0,
		p1Hazards: extractHazards(b.sides[0]),
		p2Hazards: extractHazards(b.sides[1]),
		p1Screens: extractScreens(b.sides[0]),
		p2Screens: extractScreens(b.sides[1]),
	};
}

function extractHazards(side: any): HazardState {
	const sc = side.sideConditions;
	return {
		stealthrock: !!sc.stealthrock,
		spikes: sc.spikes?.layers || 0,
		toxicspikes: sc.toxicspikes?.layers || 0,
		stickyweb: !!sc.stickyweb,
	};
}

function extractScreens(side: any): ScreenState {
	const sc = side.sideConditions;
	return {
		reflect: sc.reflect?.duration || 0,
		lightscreen: sc.lightscreen?.duration || 0,
		auroraveil: sc.auroraveil?.duration || 0,
	};
}

// ─── Pokemon State Extraction ────────────────────────────────────

export function extractMonState(pokemon: any, index: number): MonState {
	const species = pokemon.species;
	const dexMove = SimDex.moves;

	const moves: MoveInfo[] = pokemon.moveSlots.map((slot: any) => {
		const moveData = dexMove.get(slot.id);
		return {
			id: slot.id,
			name: moveData.name,
			pp: slot.pp,
			maxpp: slot.maxpp,
			disabled: !!slot.disabled,
			basePower: moveData.basePower,
			type: moveData.type,
			category: moveData.category,
			accuracy: moveData.accuracy,
			priority: moveData.priority,
			flags: moveData.flags || {},
			drain: moveData.drain || null,
			recoil: moveData.recoil || null,
			heal: moveData.heal || null,
			secondary: moveData.secondary || null,
			secondaries: moveData.secondaries || null,
			isSTAB: pokemon.types.includes(moveData.type),
			critRatio: moveData.critRatio || 1,
			multihit: moveData.multihit || null,
			target: moveData.target,
			overrideOffensiveStat: moveData.overrideOffensiveStat || undefined,
			boosts: moveData.boosts || undefined,
			selfBoost: moveData.self?.boosts || undefined,
			selfSwitch: moveData.selfSwitch || undefined,
			forceSwitch: moveData.forceSwitch || undefined,
		};
	});

	return {
		species: species.name,
		speciesId: species.id,
		types: [...pokemon.types],
		hp: pokemon.hp,
		maxhp: pokemon.maxhp,
		level: pokemon.level,
		baseStats: { ...species.baseStats },
		stats: {
			hp: pokemon.maxhp,
			atk: pokemon.storedStats?.atk || 0,
			def: pokemon.storedStats?.def || 0,
			spa: pokemon.storedStats?.spa || 0,
			spd: pokemon.storedStats?.spd || 0,
			spe: pokemon.storedStats?.spe || 0,
		},
		boosts: { ...pokemon.boosts },
		ability: pokemon.ability,
		abilityId: SimDex.toID(pokemon.ability),
		item: pokemon.item,
		itemId: SimDex.toID(pokemon.item),
		status: pokemon.status || null,
		statusTurns: pokemon.statusState?.turns || 0,
		moves,
		isActive: pokemon.isActive,
		fainted: pokemon.fainted,
		teraType: pokemon.teraType || null,
		terastallized: !!pokemon.terastallized,
		weightkg: species.weightkg,
		nature: pokemon.set?.nature || '',
		gender: pokemon.gender || '',
		position: index,
		lastItemId: SimDex.toID(pokemon.lastItem || ''),
		volatiles: Object.keys(pokemon.volatiles || {}),
	};
}

/**
 * Extract all mon states for a side.
 */
export function extractSideState(battle: Battle, sideIndex: number): MonState[] {
	const side = (battle as any).sides[sideIndex];
	return side.pokemon.map((p: any, i: number) => extractMonState(p, i));
}

/**
 * Get the active pokemon's MonState for a side.
 */
export function getActiveMon(battle: Battle, sideIndex: number): MonState | null {
	const side = (battle as any).sides[sideIndex];
	const active = side.active[0];
	if (!active || active.fainted) return null;
	const idx = side.pokemon.indexOf(active);
	return extractMonState(active, idx);
}

// ─── Dex Access ──────────────────────────────────────────────────

export function getDex() {
	return SimDex;
}

export function getTeams() {
	return SimTeams;
}

/**
 * Look up a move from the dex.
 */
export function getMove(moveId: string): any {
	return SimDex.moves.get(moveId);
}

/**
 * Look up a species from the dex.
 */
export function getSpecies(speciesId: string): any {
	return SimDex.species.get(speciesId);
}

/**
 * Look up type effectiveness: attacking type vs defending types.
 * Returns multiplier: 0, 0.25, 0.5, 1, 2, or 4.
 */
export function getTypeEffectiveness(attackType: string, defenderTypes: string[]): number {
	let multiplier = 1;
	for (const defType of defenderTypes) {
		const eff = SimDex.getEffectiveness(attackType, defType);
		if (eff > 0) multiplier *= 2;
		else if (eff < 0) multiplier *= 0.5;
		// Check immunity
		if (!SimDex.getImmunity(attackType, defType)) return 0;
	}
	return multiplier;
}

/**
 * Check type immunity.
 */
export function getTypeImmunity(attackType: string, defenderTypes: string[]): boolean {
	for (const defType of defenderTypes) {
		if (!SimDex.getImmunity(attackType, defType)) return false;
	}
	return true;
}

// ─── Utility ─────────────────────────────────────────────────────

export function getCurrentTurn(battle: Battle): number {
	return (battle as any).turn;
}

export function getRequestState(battle: Battle): string {
	return (battle as any).requestState || '';
}

/**
 * Execute a pair of choices on a battle (mutates the battle).
 */
export function makeChoices(battle: Battle, p1Choice: string, p2Choice: string): void {
	(battle as any).makeChoices(p1Choice, p2Choice);
}
