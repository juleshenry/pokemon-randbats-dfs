/**
 * types.ts — Shared interfaces for the Pokemon DFS bot
 *
 * All data structures used across modules. These are our own clean
 * representations extracted from the PS sim's internal state.
 */

// Pokemon Showdown sim types (imported from built dist)
// We re-export what we need so other modules don't import PS directly
import type { Battle, Pokemon, Side } from '../pokemon-showdown/sim';

export type { Battle, Pokemon, Side };

// ─── Stats ───────────────────────────────────────────────────────

export interface StatsTable {
	hp: number;
	atk: number;
	def: number;
	spa: number;
	spd: number;
	spe: number;
}

export interface BoostTable {
	atk: number;
	def: number;
	spa: number;
	spd: number;
	spe: number;
	accuracy: number;
	evasion: number;
}

export type StatID = 'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe';
export type BoostID = 'atk' | 'def' | 'spa' | 'spd' | 'spe' | 'accuracy' | 'evasion';

// ─── Field State ─────────────────────────────────────────────────

export interface HazardState {
	stealthrock: boolean;
	spikes: number;       // 0-3
	toxicspikes: number;  // 0-2
	stickyweb: boolean;
}

export interface ScreenState {
	reflect: number;      // turns remaining, 0 = none
	lightscreen: number;
	auroraveil: number;
}

export interface FieldState {
	weather: string | null;
	weatherTurns: number;
	terrain: string | null;
	terrainTurns: number;
	trickRoom: number;       // turns remaining, 0 = none
	p1Hazards: HazardState;
	p2Hazards: HazardState;
	p1Screens: ScreenState;
	p2Screens: ScreenState;
}

// ─── Move Info ───────────────────────────────────────────────────

export interface MoveInfo {
	id: string;
	name: string;
	pp: number;
	maxpp: number;
	disabled: boolean;
	basePower: number;
	type: string;
	category: 'Physical' | 'Special' | 'Status';
	accuracy: number | true;   // true = never-miss
	priority: number;
	flags: Record<string, number>;
	drain: [number, number] | null;    // [numerator, denominator]
	recoil: [number, number] | null;
	heal: [number, number] | null;     // for Recover etc: [1, 2] = 50%
	secondary: any | null;
	secondaries: any[] | null;
	isSTAB: boolean;
	critRatio: number;                 // 1 = normal, 2 = high crit, etc.
	multihit: number | number[] | null;
	target: string;
}

// ─── Monster State ───────────────────────────────────────────────

export interface MonState {
	species: string;
	speciesId: string;
	types: string[];
	hp: number;
	maxhp: number;
	level: number;
	baseStats: StatsTable;
	stats: StatsTable;          // computed stats (base + EV + IV + nature)
	boosts: BoostTable;
	ability: string;
	abilityId: string;
	item: string;
	itemId: string;
	status: string | null;      // 'brn' | 'par' | 'psn' | 'tox' | 'slp' | 'frz' | null
	statusTurns: number;
	moves: MoveInfo[];
	isActive: boolean;
	fainted: boolean;
	teraType: string | null;
	terastallized: boolean;
	weightkg: number;
	nature: string;
	gender: string;
	position: number;           // index in side.pokemon[]
}

// ─── Damage Calculation ──────────────────────────────────────────

export interface DamageResult {
	min: number;
	max: number;
	expected: number;                  // avg damage roll (~92.5% point)
	expectedWithAccuracy: number;      // expected * (accuracy/100)
	expectedWithCrit: number;          // folds in crit probability
	percentMin: number;                // min / defender.maxhp
	percentMax: number;
	percentExpected: number;
	isOHKO: boolean;                   // min >= defender.hp
	turnsToKO: number;                 // expected turns to KO (no recovery)
	moveName: string;
	moveType: string;
	effectiveness: number;             // 0, 0.25, 0.5, 1, 2, 4
}

export interface TurnsToKOResult {
	move: string;
	moveName: string;
	turnsToKO: number;                 // includes setup turns if applicable
	setupTurns: number;                // how many boosts before attacking
	totalDamagePerTurn: number;        // after break point
	recoveryPerTurn: number;           // opponent's healing
	breaksThrough: boolean;            // can this strategy actually win?
}

export interface SpeedResult {
	faster: 'p1' | 'p2' | 'tie';
	p1Speed: number;
	p2Speed: number;
	p1Priority: number;
	p2Priority: number;
}

// ─── Nash Equilibrium ────────────────────────────────────────────

export interface NashResult {
	p1Strategy: StrategyEntry[];       // mixed strategy for player 1
	p2Strategy: StrategyEntry[];       // mixed strategy for player 2
	gameValue: number;                 // expected payoff under equilibrium
}

export interface StrategyEntry {
	choice: string;                    // 'move 1', 'switch 3', etc.
	label: string;                     // human-readable name
	probability: number;              // 0-1
}

// ─── Turn Plan / Dense Output ────────────────────────────────────

export interface TurnPlan {
	turn: number;
	choice: string;
	moveName: string;
	evaluation: number;                // [-1, 1]
}

export interface ConditionalBranch {
	opponentMove: string;              // what the opponent might do
	response: TurnPlan;                // our best response
	evaluation: number;
}

export interface DensePlan {
	turn: number;
	mixedStrategy: StrategyEntry[];
	gameValue: number;
	topLines: TurnPlan[][];            // top 3-turn sequences
	conditionalPlans: ConditionalBranch[];
	shadowTeamSummary?: ShadowTeamSummary;
}

// ─── Shadow Team (Team Predictor) ────────────────────────────────

export interface SetData {
	role: string;
	movepool: string[];
	abilities: string[];
	teraTypes: string[];
}

export interface SpeciesEntry {
	level: number;
	sets: SetData[];
}

export interface RevealedMon {
	species: string;
	speciesId: string;
	level: number;
	ability: string;
	knownMoves: string[];
	possibleSets: SetData[];
	inferredMoveset: string[] | null;
	item: string | null;
	teraType: string | null;
	types: string[];
	fainted: boolean;
}

export interface CandidateInfo {
	speciesId: string;
	species: string;
	types: string[];
	level: number;
	weight: number;                    // probability weight
	sets: SetData[];
}

export interface ShadowTeam {
	revealed: RevealedMon[];
	candidates: Map<string, CandidateInfo>;
	totalWeight: number;
	typeCount: Record<string, number>;
	weaknessCount: Record<string, number>;
	doubleWeaknessCount: Record<string, number>;
	freezeDryWeakCount: number;
	hasTeraBlastUser: boolean;
	hasLevel100: boolean;
	baseFormesSeen: Set<string>;
	teamDetails: TeamDetails;
	slotsRemaining: number;
}

export interface TeamDetails {
	rain: number;
	sun: number;
	sand: number;
	snow: number;
	stealthRock: number;
	spikes: number;
	toxicSpikes: number;
	stickyWeb: number;
	defog: number;
	rapidSpin: number;
	screens: number;
	statusCure: number;
	teraBlast: number;
}

export interface ShadowTeamSummary {
	slotsRemaining: number;
	topCandidates: { species: string; probability: number; types: string[] }[];
	likelyTypes: { type: string; probability: number }[];
	threats: { species: string; probability: number; reason: string }[];
	absences: string[];                // "No Water-resist likely" etc.
}

// ─── Choice Representation ───────────────────────────────────────

export interface Choice {
	choiceString: string;              // 'move 1', 'switch 3', etc.
	label: string;                     // 'Thunderbolt', 'Switch to Garchomp'
	type: 'move' | 'switch';
	moveIndex?: number;                // 0-based if move
	switchIndex?: number;              // 1-based if switch (PS format)
	terastallize?: boolean;
}
