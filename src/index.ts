#!/usr/bin/env node
/**
 * index.ts — CLI entry point for the Pokemon DFS bot
 *
 * Modes:
 *   1v1:    --p1 <species> --p2 <species> [options]
 *   random: --random [--seed s1,s2,s3,s4] [options]
 *   demo:   --demo (runs the CM Jirachi vs Recover Gastrodon matchup)
 *
 * Options:
 *   --depth N       Search depth (default 3)
 *   --time N        Time limit in ms (default 30000)
 *   --player 0|1    Which player we are (default 0)
 *   --turn N        Advance battle N turns with random play before analyzing
 *   --shadow        Enable shadow team inference (default: on for 6v6)
 *   --no-shadow     Disable shadow team inference
 *   --moves p1m1,p1m2,... --moves2 p2m1,p2m2,...  Custom moves for 1v1
 *   --ability <a>   P1 ability    --ability2 <a>   P2 ability
 *   --item <i>      P1 item       --item2 <i>      P2 item
 *   --tera <t>      P1 tera type  --tera2 <t>      P2 tera type
 *   --level N       P1 level      --level2 N       P2 level
 *   --verbose       Show detailed eval + debug info
 */

import {
	createRandomBattle, create1v1Battle, createBattle,
	getActiveMon, extractSideState, extractFieldState,
	getCurrentTurn, getChoices, cloneBattle, makeChoices,
	getDex, isTerminal, getWinValue,
} from './state';
import { search, buildDensePlan, formatDensePlan, type SearchOptions } from './minimax';
import {
	createShadowTeam, revealMon, getShadowTeamSummary,
	formatShadowTeamSummary,
} from './team-predictor';
import { evaluateDetailed } from './eval';
import type { Battle, ShadowTeam } from './types';

// ─── Arg Parsing ────────────────────────────────────────────────

interface CLIArgs {
	mode: 'random' | '1v1' | 'demo';
	p1Species?: string;
	p2Species?: string;
	p1Moves?: string[];
	p2Moves?: string[];
	p1Ability?: string;
	p2Ability?: string;
	p1Item?: string;
	p2Item?: string;
	p1Tera?: string;
	p2Tera?: string;
	p1Level?: number;
	p2Level?: number;
	seed?: [number, number, number, number];
	depth: number;
	timeLimit: number;
	playerIndex: number;
	advanceTurns: number;
	useShadow: boolean;
	verbose: boolean;
}

function parseArgs(argv: string[]): CLIArgs {
	const args: CLIArgs = {
		mode: 'demo',
		depth: 3,
		timeLimit: 30000,
		playerIndex: 0,
		advanceTurns: 0,
		useShadow: true,
		verbose: false,
	};

	let i = 2; // skip node, script
	while (i < argv.length) {
		const flag = argv[i];
		switch (flag) {
			case '--random':
				args.mode = 'random';
				break;
			case '--demo':
				args.mode = 'demo';
				break;
			case '--p1':
				args.mode = '1v1';
				args.p1Species = argv[++i];
				break;
			case '--p2':
				args.p2Species = argv[++i];
				break;
			case '--moves':
				args.p1Moves = argv[++i].split(',');
				break;
			case '--moves2':
				args.p2Moves = argv[++i].split(',');
				break;
			case '--ability':
				args.p1Ability = argv[++i];
				break;
			case '--ability2':
				args.p2Ability = argv[++i];
				break;
			case '--item':
				args.p1Item = argv[++i];
				break;
			case '--item2':
				args.p2Item = argv[++i];
				break;
			case '--tera':
				args.p1Tera = argv[++i];
				break;
			case '--tera2':
				args.p2Tera = argv[++i];
				break;
			case '--level':
				args.p1Level = parseInt(argv[++i]);
				break;
			case '--level2':
				args.p2Level = parseInt(argv[++i]);
				break;
			case '--seed': {
				const parts = argv[++i].split(',').map(Number);
				args.seed = [parts[0] || 1, parts[1] || 2, parts[2] || 3, parts[3] || 4];
				break;
			}
			case '--depth':
				args.depth = parseInt(argv[++i]);
				break;
			case '--time':
				args.timeLimit = parseInt(argv[++i]);
				break;
			case '--player':
				args.playerIndex = parseInt(argv[++i]);
				break;
			case '--turn':
				args.advanceTurns = parseInt(argv[++i]);
				break;
			case '--shadow':
				args.useShadow = true;
				break;
			case '--no-shadow':
				args.useShadow = false;
				break;
			case '--verbose':
				args.verbose = true;
				break;
			case '--help':
			case '-h':
				printUsage();
				process.exit(0);
			default:
				console.error(`Unknown flag: ${flag}`);
				printUsage();
				process.exit(1);
		}
		i++;
	}

	return args;
}

function printUsage(): void {
	console.log(`
Pokemon DFS Bot — Gen 9 Random Battles Minimax + Nash Equilibrium

Usage:
  npx ts-node src/index.ts --demo                       CM Jirachi vs Recover Gastrodon
  npx ts-node src/index.ts --random [--seed 1,2,3,4]    Random battle
  npx ts-node src/index.ts --p1 jirachi --p2 gastrodon  Custom 1v1

Options:
  --depth N         Search depth in turns (default: 3)
  --time N          Time limit in ms (default: 30000)
  --player 0|1      Which player we are (default: 0)
  --turn N          Advance N turns with default play before analyzing
  --moves m1,m2,... P1 moves   --moves2 m1,m2,...  P2 moves
  --ability A       P1 ability --ability2 A        P2 ability
  --item I          P1 item    --item2 I           P2 item
  --tera T          P1 tera    --tera2 T           P2 tera
  --level N         P1 level   --level2 N          P2 level
  --no-shadow       Disable shadow team inference
  --verbose         Show detailed evaluation breakdown
  --help            Show this message
`);
}

// ─── Battle Setup ───────────────────────────────────────────────

function createDemoBattle(): Battle {
	// CM Jirachi vs Recover Gastrodon — the litmus test matchup
	return create1v1Battle(
		{
			species: 'Jirachi',
			moves: ['Calm Mind', 'Psychic', 'Flash Cannon', 'Wish'],
			ability: 'Serene Grace',
			item: 'Leftovers',
			teraType: 'Psychic',
		},
		{
			species: 'Gastrodon',
			moves: ['Scald', 'Earth Power', 'Recover', 'Toxic'],
			ability: 'Storm Drain',
			item: 'Leftovers',
			teraType: 'Ground',
		},
	);
}

function createCustom1v1(args: CLIArgs): Battle {
	if (!args.p1Species || !args.p2Species) {
		console.error('Error: --p1 and --p2 are required for 1v1 mode');
		process.exit(1);
	}

	const p1Set: Record<string, any> = { species: args.p1Species };
	const p2Set: Record<string, any> = { species: args.p2Species };

	if (args.p1Moves) p1Set.moves = args.p1Moves;
	if (args.p2Moves) p2Set.moves = args.p2Moves;
	if (args.p1Ability) p1Set.ability = args.p1Ability;
	if (args.p2Ability) p2Set.ability = args.p2Ability;
	if (args.p1Item) p1Set.item = args.p1Item;
	if (args.p2Item) p2Set.item = args.p2Item;
	if (args.p1Tera) p1Set.teraType = args.p1Tera;
	if (args.p2Tera) p2Set.teraType = args.p2Tera;
	if (args.p1Level) p1Set.level = args.p1Level;
	if (args.p2Level) p2Set.level = args.p2Level;

	return create1v1Battle(p1Set, p2Set, {
		seed: args.seed,
	});
}

// ─── Shadow Team from Battle ────────────────────────────────────

/**
 * Build a shadow team by revealing all of the opponent's visible Pokemon.
 * In a real online battle, this would be done incrementally as mons appear.
 */
function buildShadowFromBattle(battle: Battle, playerIndex: number): ShadowTeam {
	const shadow = createShadowTeam();
	const opponentSide = playerIndex === 0 ? 1 : 0;
	const opponentMons = extractSideState(battle, opponentSide);

	// Reveal the active mon (always visible)
	const active = opponentMons.find(m => m.isActive && !m.fainted);
	if (active) {
		revealMon(
			shadow,
			active.speciesId,
			active.level,
			active.ability,
			active.moves.map(m => m.id),
			active.item || null,
			active.terastallized ? active.teraType : null,
			active.fainted,
		);
	}

	return shadow;
}

// ─── Verbose Evaluation ─────────────────────────────────────────

function printVerboseEval(battle: Battle, shadow?: ShadowTeam): void {
	const d = evaluateDetailed(battle, shadow);
	console.log('\n--- Detailed Evaluation ---');
	console.log(`  HP component:      ${fmtSign(d.hp * 0.25)} (raw: ${fmtSign(d.hp)})`);
	console.log(`  Count component:   ${fmtSign(d.count * 0.20)} (raw: ${fmtSign(d.count)})`);
	console.log(`  Matchup (TKO):     ${fmtSign(d.matchup * 0.30)} (raw: ${fmtSign(d.matchup)})`);
	console.log(`  Setup progress:    ${fmtSign(d.setup * 0.15)} (raw: ${fmtSign(d.setup)})`);
	console.log(`  Hazard advantage:  ${fmtSign(d.hazards * 0.10)} (raw: ${fmtSign(d.hazards)})`);
	if (d.shadowRisk !== 0) {
		console.log(`  Shadow risk:       ${fmtSign(-d.shadowRisk)}`);
	}
	console.log(`  TOTAL:             ${fmtSign(d.total)}`);
}

function fmtSign(n: number): string {
	return (n >= 0 ? '+' : '') + n.toFixed(3);
}

// ─── Battle State Display ───────────────────────────────────────

function printBattleState(battle: Battle): void {
	const p1Active = getActiveMon(battle, 0);
	const p2Active = getActiveMon(battle, 1);
	const field = extractFieldState(battle);

	console.log('\n--- Battle State ---');
	console.log(`Turn: ${getCurrentTurn(battle)}`);

	if (p1Active) {
		const hpPct = ((p1Active.hp / p1Active.maxhp) * 100).toFixed(1);
		const status = p1Active.status ? ` [${p1Active.status.toUpperCase()}]` : '';
		const tera = p1Active.terastallized ? ` (Tera ${p1Active.teraType})` : '';
		const boostStr = formatBoosts(p1Active.boosts);
		console.log(`P1: ${p1Active.species} ${hpPct}% HP${status}${tera}${boostStr}`);
		console.log(`    Moves: ${p1Active.moves.map(m => m.name).join(', ')}`);
		console.log(`    Ability: ${p1Active.ability}  Item: ${p1Active.item || 'none'}`);
	}

	if (p2Active) {
		const hpPct = ((p2Active.hp / p2Active.maxhp) * 100).toFixed(1);
		const status = p2Active.status ? ` [${p2Active.status.toUpperCase()}]` : '';
		const tera = p2Active.terastallized ? ` (Tera ${p2Active.teraType})` : '';
		const boostStr = formatBoosts(p2Active.boosts);
		console.log(`P2: ${p2Active.species} ${hpPct}% HP${status}${tera}${boostStr}`);
		console.log(`    Moves: ${p2Active.moves.map(m => m.name).join(', ')}`);
		console.log(`    Ability: ${p2Active.ability}  Item: ${p2Active.item || 'none'}`);
	}

	// Field conditions
	const conditions: string[] = [];
	if (field.weather) conditions.push(`Weather: ${field.weather} (${field.weatherTurns}t)`);
	if (field.terrain) conditions.push(`Terrain: ${field.terrain} (${field.terrainTurns}t)`);
	if (field.trickRoom > 0) conditions.push(`Trick Room (${field.trickRoom}t)`);
	if (conditions.length > 0) {
		console.log(`Field: ${conditions.join(', ')}`);
	}

	// Hazards
	const p1Haz = formatHazards(field.p1Hazards, 'P1');
	const p2Haz = formatHazards(field.p2Hazards, 'P2');
	if (p1Haz) console.log(`  ${p1Haz}`);
	if (p2Haz) console.log(`  ${p2Haz}`);

	// Team overview
	const p1Team = extractSideState(battle, 0);
	const p2Team = extractSideState(battle, 1);
	const p1Alive = p1Team.filter(m => !m.fainted).length;
	const p2Alive = p2Team.filter(m => !m.fainted).length;
	console.log(`Team: P1 ${p1Alive}/${p1Team.length} alive, P2 ${p2Alive}/${p2Team.length} alive`);

	// Bench (non-active, non-fainted)
	const p1Bench = p1Team.filter(m => !m.isActive && !m.fainted);
	if (p1Bench.length > 0) {
		console.log(`  P1 bench: ${p1Bench.map(m => `${m.species} (${((m.hp / m.maxhp) * 100).toFixed(0)}%)`).join(', ')}`);
	}
	const p2Bench = p2Team.filter(m => !m.isActive && !m.fainted);
	if (p2Bench.length > 0) {
		console.log(`  P2 bench: ${p2Bench.map(m => `${m.species} (${((m.hp / m.maxhp) * 100).toFixed(0)}%)`).join(', ')}`);
	}
}

function formatBoosts(boosts: { atk: number; def: number; spa: number; spd: number; spe: number; accuracy: number; evasion: number }): string {
	const parts: string[] = [];
	const entries: [string, number][] = [
		['atk', boosts.atk], ['def', boosts.def], ['spa', boosts.spa],
		['spd', boosts.spd], ['spe', boosts.spe],
		['acc', boosts.accuracy], ['eva', boosts.evasion],
	];
	for (const [stat, val] of entries) {
		if (val !== 0) parts.push(`${stat}${val > 0 ? '+' : ''}${val}`);
	}
	return parts.length > 0 ? ` [${parts.join(', ')}]` : '';
}

function formatHazards(h: any, side: string): string {
	const parts: string[] = [];
	if (h.stealthrock) parts.push('SR');
	if (h.spikes > 0) parts.push(`Spikes x${h.spikes}`);
	if (h.toxicspikes > 0) parts.push(`TSpikes x${h.toxicspikes}`);
	if (h.stickyweb) parts.push('Web');
	if (parts.length === 0) return '';
	return `${side} hazards: ${parts.join(', ')}`;
}

// ─── Advance Turns ──────────────────────────────────────────────

/**
 * Advance the battle by N turns using 'default' choices.
 * Useful for testing mid-game scenarios.
 */
function advanceBattle(battle: Battle, turns: number): void {
	for (let t = 0; t < turns; t++) {
		if (isTerminal(battle)) break;
		const p1Choices = getChoices(battle, 0);
		const p2Choices = getChoices(battle, 1);
		const p1 = p1Choices.length > 0 ? p1Choices[0].choiceString : 'default';
		const p2 = p2Choices.length > 0 ? p2Choices[0].choiceString : 'default';
		makeChoices(battle, p1, p2);
	}
}

// ─── Main ───────────────────────────────────────────────────────

function main(): void {
	const args = parseArgs(process.argv);

	console.log('Pokemon DFS Bot — Gen 9 Random Battles');
	console.log('Minimax + Nash Equilibrium + Shadow Team Inference');
	console.log('─'.repeat(52));

	// Create battle
	let battle: Battle;
	switch (args.mode) {
		case 'demo':
			console.log('\nMode: Demo (CM Jirachi vs Recover Gastrodon)');
			battle = createDemoBattle();
			break;
		case 'random':
			console.log(`\nMode: Random Battle (seed: ${args.seed?.join(',') ?? 'default'})`);
			battle = createRandomBattle(args.seed);
			break;
		case '1v1':
			console.log(`\nMode: 1v1 (${args.p1Species} vs ${args.p2Species})`);
			battle = createCustom1v1(args);
			break;
	}

	// Advance turns if requested
	if (args.advanceTurns > 0) {
		console.log(`\nAdvancing ${args.advanceTurns} turns...`);
		advanceBattle(battle, args.advanceTurns);
	}

	// Check for terminal state
	const winVal = getWinValue(battle);
	if (winVal !== null) {
		console.log(`\nBattle already ended. Winner: ${winVal > 0 ? 'P1' : winVal < 0 ? 'P2' : 'Tie'}`);
		return;
	}

	// Print battle state
	printBattleState(battle);

	// Build shadow team (for 6v6 or if forced on)
	let shadow: ShadowTeam | undefined;
	const teamSize = extractSideState(battle, 0).length;

	if (args.useShadow && teamSize > 1) {
		shadow = buildShadowFromBattle(battle, args.playerIndex);
		const summary = getShadowTeamSummary(shadow);
		console.log('\n' + formatShadowTeamSummary(summary));
	}

	// Verbose evaluation
	if (args.verbose) {
		printVerboseEval(battle, shadow);
	}

	// Run search
	const p1Active = getActiveMon(battle, 0);
	const p2Active = getActiveMon(battle, 1);

	if (!p1Active || !p2Active) {
		console.log('\nNo active Pokemon on one or both sides. Cannot search.');
		return;
	}

	console.log(`\nSearching (depth ${args.depth}, time limit ${args.timeLimit}ms, player ${args.playerIndex})...`);

	const searchStart = Date.now();
	const options: SearchOptions = {
		depth: args.depth,
		shadow,
		playerIndex: args.playerIndex,
		timeLimit: args.timeLimit,
	};

	const result = search(battle, options);
	const searchTime = Date.now() - searchStart;

	// Build and format dense plan
	const shadowSummary = shadow ? getShadowTeamSummary(shadow) : undefined;
	const plan = buildDensePlan(result, shadowSummary);
	const output = formatDensePlan(plan, p1Active.species, p2Active.species);

	console.log('\n' + output);

	// Performance stats
	console.log('--- Search Stats ---');
	console.log(`  Nodes visited: ${result.nodesVisited.toLocaleString()}`);
	console.log(`  Time: ${searchTime}ms`);
	console.log(`  Nodes/sec: ${Math.round(result.nodesVisited / (searchTime / 1000)).toLocaleString()}`);

	// Available choices (for reference)
	const choices = getChoices(battle, args.playerIndex);
	console.log(`\n  Available choices: ${choices.map(c => c.label).join(', ')}`);
}

main();
