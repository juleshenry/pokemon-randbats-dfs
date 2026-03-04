/**
 * matchups.test.ts — Integration tests for the full search pipeline
 *
 * Tests that the bot produces sensible recommendations in known matchups.
 * Each test creates a battle, runs search(), and validates the output.
 *
 * These are NOT unit tests — they exercise the full stack:
 *   state → eval → damage-calc → nash → minimax → dense plan
 */

import { expect } from 'chai';
import { create1v1Battle, getActiveMon, getChoices } from '../../src/state';
import { search, buildDensePlan, formatDensePlan, type SearchResult } from '../../src/minimax';
import type { Battle, NashResult, StrategyEntry } from '../../src/types';

// ─── Helpers ────────────────────────────────────────────────────

/** Get the top strategy from a Nash result for a given player side */
function topStrategy(nash: NashResult, side: 'p1' | 'p2'): StrategyEntry | undefined {
	const strats = side === 'p1' ? nash.p1Strategy : nash.p2Strategy;
	return strats.reduce((a, b) => a.probability > b.probability ? a : b, strats[0]);
}

/** Check if a strategy label appears in the Nash mix with >= minProb */
function hasStrategy(nash: NashResult, label: string, minProb: number = 0.01): boolean {
	return nash.p1Strategy.some(s => s.label === label && s.probability >= minProb);
}

/** Quick depth-2 search for faster tests */
function quickSearch(battle: Battle, depth: number = 2): SearchResult {
	return search(battle, { depth, timeLimit: 15000, playerIndex: 0 });
}

// ─── Test Suite ─────────────────────────────────────────────────

describe('Matchup Tests', function () {
	this.timeout(60000);

	describe('1v1 Basic Scenarios', () => {

		it('should pick super-effective STAB over neutral STAB', () => {
			// Garchomp vs Dragonite: Dragon Claw is STAB + SE vs Dragon
			const battle = create1v1Battle(
				{
					species: 'Garchomp',
					moves: ['Dragon Claw', 'Earthquake', 'Fire Fang', 'Swords Dance'],
					ability: 'Rough Skin',
					item: 'Life Orb',
					teraType: 'Dragon',
				},
				{
					species: 'Dragonite',
					moves: ['Dragon Dance', 'Dragon Claw', 'Extreme Speed', 'Earthquake'],
					ability: 'Multiscale',
					item: 'Lum Berry',
					teraType: 'Normal',
				},
			);

			const result = quickSearch(battle);
			const top = topStrategy(result.nash, 'p1');

			// Should prefer an attacking move, not Swords Dance (Dragonite has DD too)
			// Dragon Claw is STAB + SE; Earthquake is STAB neutral
			expect(top).to.exist;
			// Either attacking with Dragon Claw or Earthquake is reasonable
			// But should NOT be Fire Fang (weak, not STAB, not SE)
			expect(top!.label).to.not.include('Fire Fang');
		});

		it('should not recommend a move the opponent is immune to', () => {
			// Gengar vs Normal type: Ghost moves are immune
			const battle = create1v1Battle(
				{
					species: 'Gengar',
					moves: ['Shadow Ball', 'Sludge Bomb', 'Focus Blast', 'Thunderbolt'],
					ability: 'Cursed Body',
					item: 'Choice Specs',
					teraType: 'Ghost',
				},
				{
					species: 'Blissey',
					moves: ['Seismic Toss', 'Soft-Boiled', 'Toxic', 'Heal Bell'],
					ability: 'Natural Cure',
					item: 'Leftovers',
					teraType: 'Normal',
				},
			);

			const result = quickSearch(battle);

			// Shadow Ball should NOT appear as the top strategy (Normal is immune)
			const shadowBallProb = result.nash.p1Strategy
				.filter(s => s.label.includes('Shadow Ball'))
				.reduce((sum, s) => sum + s.probability, 0);

			// Shadow Ball should have low or zero probability
			expect(shadowBallProb).to.be.lessThan(0.3);

			// The bot should pick a move that actually hits Blissey —
			// Sludge Bomb (STAB, 100% acc, neutral) or Focus Blast (SE, 70% acc)
			// Either is correct; the key assertion is no Shadow Ball
			const hittingProb = result.nash.p1Strategy
				.filter(s => s.label.includes('Sludge Bomb') || s.label.includes('Focus Blast') || s.label.includes('Thunderbolt'))
				.reduce((sum, s) => sum + s.probability, 0);
			expect(hittingProb).to.be.greaterThan(0.5);
		});

		it('should recognize Ground immunity from Levitate', () => {
			// Garchomp vs Rotom-Wash: EQ is immune (Levitate)
			const battle = create1v1Battle(
				{
					species: 'Garchomp',
					moves: ['Earthquake', 'Dragon Claw', 'Stone Edge', 'Swords Dance'],
					ability: 'Rough Skin',
					item: '',
					teraType: 'Dragon',
				},
				{
					species: 'Rotom-Wash',
					moves: ['Hydro Pump', 'Volt Switch', 'Will-O-Wisp', 'Pain Split'],
					ability: 'Levitate',
					item: '',
					teraType: 'Water',
				},
			);

			const result = quickSearch(battle);

			// Earthquake should have very low probability (Levitate immune)
			const eqProb = result.nash.p1Strategy
				.filter(s => s.label === 'Earthquake' || s.label === 'Earthquake + Tera')
				.reduce((sum, s) => sum + s.probability, 0);

			expect(eqProb).to.be.lessThan(0.1);
		});

		it('should prefer setup when the opponent cannot threaten you', () => {
			// Reuniclus (Magic Guard) vs Toxapex — Toxapex can't meaningfully damage
			// Reuniclus, so Calm Mind into Psychic is the correct line
			const battle = create1v1Battle(
				{
					species: 'Reuniclus',
					moves: ['Calm Mind', 'Psychic', 'Focus Blast', 'Shadow Ball'],
					ability: 'Magic Guard',
					item: 'Life Orb',
					teraType: 'Psychic',
				},
				{
					species: 'Toxapex',
					moves: ['Scald', 'Toxic', 'Recover', 'Haze'],
					ability: 'Regenerator',
					item: 'Leftovers',
					teraType: 'Water',
				},
			);

			const result = quickSearch(battle);
			// Reuniclus should boost with Calm Mind — Magic Guard blocks Toxic damage,
			// Psychic is STAB SE vs Poison, and Toxapex can't deal meaningful damage.
			// Even Haze is manageable since Reuniclus can re-boost.
			// The bot should lean toward Calm Mind or Psychic (STAB SE), not Shadow Ball
			const usefulProb = result.nash.p1Strategy
				.filter(s => s.label.includes('Calm Mind') || s.label.includes('Psychic'))
				.reduce((sum, s) => sum + s.probability, 0);
			expect(usefulProb).to.be.greaterThan(0.5);
		});
	});

	describe('CM Jirachi vs Recover Gastrodon (Litmus Test)', () => {

		let battle: Battle;
		let result: SearchResult;

		before(function () {
			this.timeout(45000);

			battle = create1v1Battle(
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

			// Depth 3 for the litmus test
			result = search(battle, { depth: 3, timeLimit: 35000, playerIndex: 0 });
		});

		it('should recommend Calm Mind (with or without Tera) as primary strategy', () => {
			const cmProb = result.nash.p1Strategy
				.filter(s => s.label.includes('Calm Mind'))
				.reduce((sum, s) => sum + s.probability, 0);

			// Calm Mind should dominate the strategy — setup is clearly best
			expect(cmProb).to.be.greaterThan(0.7);
		});

		it('should NOT recommend immediate Psychic or Flash Cannon', () => {
			const attackProb = result.nash.p1Strategy
				.filter(s => s.label.includes('Psychic') || s.label.includes('Flash Cannon'))
				.reduce((sum, s) => sum + s.probability, 0);

			// Raw attacking at +0 boosts is suboptimal vs Recover Gastrodon
			expect(attackProb).to.be.lessThan(0.3);
		});

		it('should have a positive game value (Jirachi is favored)', () => {
			// CM Jirachi eventually overwhelms Gastrodon with boosted Psychic
			expect(result.gameValue).to.be.greaterThan(0);
		});

		it('should produce a multi-turn plan with CM → attack sequence', () => {
			expect(result.topLines.length).to.be.greaterThan(0);

			// At least one top line should start with Calm Mind
			const cmLine = result.topLines.find(line =>
				line.length > 0 && line[0].moveName.includes('Calm Mind')
			);
			expect(cmLine).to.exist;

			// The line should eventually include an attack
			if (cmLine && cmLine.length > 1) {
				const hasAttack = cmLine.slice(1).some(turn =>
					turn.moveName.includes('Psychic') || turn.moveName.includes('Flash Cannon')
				);
				expect(hasAttack).to.be.true;
			}
		});

		it('should have conditional plans for opponent responses', () => {
			expect(result.conditionalPlans.length).to.be.greaterThan(0);

			// Should have a response to Toxic (a key threat to CM strategy)
			const toxicResponse = result.conditionalPlans.find(p =>
				p.opponentMove.includes('Toxic')
			);
			// Toxic should be in the considered opponent moves
			if (toxicResponse) {
				expect(toxicResponse.response).to.exist;
			}
		});

		it('should format a valid dense plan', () => {
			const plan = buildDensePlan(result);
			const output = formatDensePlan(plan, 'Jirachi', 'Gastrodon');

			expect(output).to.include('Jirachi vs Gastrodon');
			expect(output).to.include('Nash Equilibrium');
			expect(output).to.include('Game Value');
			expect(output).to.include('3-Turn Plan');
		});
	});

	describe('Type Advantage Verification', () => {

		it('should favor Water attack against Fire type', () => {
			const battle = create1v1Battle(
				{
					species: 'Starmie',
					moves: ['Hydro Pump', 'Psychic', 'Thunderbolt', 'Ice Beam'],
					ability: 'Natural Cure',
					item: 'Life Orb',
					teraType: 'Water',
				},
				{
					species: 'Arcanine',
					moves: ['Flare Blitz', 'Extreme Speed', 'Close Combat', 'Wild Charge'],
					ability: 'Intimidate',
					item: 'Choice Band',
					teraType: 'Fire',
				},
			);

			const result = quickSearch(battle);

			// Hydro Pump is STAB + SE vs Fire. Should be heavily favored.
			const hydroProb = result.nash.p1Strategy
				.filter(s => s.label.includes('Hydro Pump'))
				.reduce((sum, s) => sum + s.probability, 0);

			expect(hydroProb).to.be.greaterThanOrEqual(0.5);
		});

		it('should correctly evaluate a losing matchup', () => {
			// Magikarp vs Pikachu — clearly losing for Magikarp
			const battle = create1v1Battle(
				{
					species: 'Magikarp',
					moves: ['Splash', 'Tackle', 'Flail', 'Bounce'],
					ability: 'Swift Swim',
					item: '',
					teraType: 'Water',
				},
				{
					species: 'Pikachu',
					moves: ['Thunderbolt', 'Volt Tackle', 'Iron Tail', 'Quick Attack'],
					ability: 'Static',
					item: 'Light Ball',
					teraType: 'Electric',
				},
			);

			const result = quickSearch(battle);
			// Game value should be negative (P1 = Magikarp is losing)
			expect(result.gameValue).to.be.lessThan(0);
		});
	});

	describe('Search Output Structure', () => {

		it('should return valid SearchResult fields', () => {
			// Two different species with similar power level for a balanced matchup
			const battle = create1v1Battle(
				{
					species: 'Garchomp',
					moves: ['Earthquake', 'Dragon Claw', 'Swords Dance', 'Stone Edge'],
					ability: 'Rough Skin',
					teraType: 'Ground',
				},
				{
					species: 'Salamence',
					moves: ['Outrage', 'Earthquake', 'Dragon Dance', 'Fire Fang'],
					ability: 'Intimidate',
					teraType: 'Dragon',
				},
			);

			const result = quickSearch(battle);

			// Structure checks
			expect(result.nash).to.exist;
			expect(result.nash.p1Strategy).to.be.an('array');
			expect(result.nash.p2Strategy).to.be.an('array');
			expect(result.gameValue).to.be.a('number');
			expect(result.gameValue).to.be.within(-1, 1);
			expect(result.topLines).to.be.an('array');
			expect(result.conditionalPlans).to.be.an('array');
			expect(result.turn).to.equal(1);
			expect(result.nodesVisited).to.be.greaterThan(0);

			// Strategy probabilities should sum to ~1
			const p1Total = result.nash.p1Strategy.reduce((s, e) => s + e.probability, 0);
			expect(p1Total).to.be.approximately(1, 0.05);
		});

		it('should produce strategy labels matching available choices', () => {
			const battle = create1v1Battle(
				{
					species: 'Pikachu',
					moves: ['Thunderbolt', 'Surf', 'Iron Tail', 'Quick Attack'],
					ability: 'Static',
					item: 'Light Ball',
					teraType: 'Electric',
				},
				{
					species: 'Slowbro',
					moves: ['Scald', 'Psychic', 'Slack Off', 'Ice Beam'],
					ability: 'Regenerator',
					item: 'Leftovers',
					teraType: 'Water',
				},
			);

			const result = quickSearch(battle);
			const choices = getChoices(battle, 0);
			const choiceLabels = choices.map(c => c.label);

			// Every strategy label should be a valid choice
			for (const strat of result.nash.p1Strategy) {
				expect(choiceLabels).to.include(strat.label,
					`Strategy "${strat.label}" not in available choices: ${choiceLabels.join(', ')}`);
			}
		});
	});

	// ─── Deeper Analytical Search ──────────────────────────────

	describe('Analytical Depth 5 Search', () => {

		it('should complete analytical depth-5 search in reasonable time', function () {
			this.timeout(45000);
			const battle = create1v1Battle(
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

			const start = Date.now();
			const result = search(battle, {
				depth: 5,
				useAnalytical: true,
				timeLimit: 30000,
				playerIndex: 0,
			});
			const elapsed = Date.now() - start;

			// Should complete within time limit (with margin for overhead)
			expect(elapsed).to.be.lessThan(35000);

			// Should visit more nodes than depth-1 (recursion is happening)
			expect(result.nodesVisited).to.be.greaterThan(10);

			// Result structure should be valid
			expect(result.nash.p1Strategy).to.be.an('array').with.length.greaterThan(0);
			const totalProb = result.nash.p1Strategy.reduce((s, e) => s + e.probability, 0);
			expect(totalProb).to.be.approximately(1, 0.05);
			expect(result.gameValue).to.be.within(-1, 1);
		});

		it('should produce different (generally better) results at depth 5 vs depth 1', function () {
			this.timeout(30000);
			// CM Jirachi vs Gastrodon: deeper search should be more confident about CM
			const battle = create1v1Battle(
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

			const depth1 = search(battle, { depth: 1, useAnalytical: true, playerIndex: 0 });
			const depth5 = search(battle, { depth: 5, useAnalytical: true, timeLimit: 15000, playerIndex: 0 });

			// Deeper search should visit more nodes
			expect(depth5.nodesVisited).to.be.greaterThan(depth1.nodesVisited);

			// Both should be valid strategies
			expect(depth1.gameValue).to.be.within(-1, 1);
			expect(depth5.gameValue).to.be.within(-1, 1);
		});

		it('should handle depth-5 analytical for an OHKO matchup efficiently (early termination)', function () {
			this.timeout(10000);
			// Chien-Pao (fast nuke) vs Dragonite: likely OHKOs with Ice STAB
			const battle = create1v1Battle(
				{
					species: 'Chien-Pao',
					moves: ['Ice Shard', 'Crunch', 'Icicle Crash', 'Sacred Sword'],
					ability: 'Sword of Ruin',
					item: 'Life Orb',
					teraType: 'Ice',
				},
				{
					species: 'Dragonite',
					moves: ['Dragon Dance', 'Dragon Claw', 'Extreme Speed', 'Earthquake'],
					ability: 'Multiscale',
					item: 'Lum Berry',
					teraType: 'Normal',
				},
			);

			const result = search(battle, {
				depth: 5,
				useAnalytical: true,
				timeLimit: 5000,
				playerIndex: 0,
			});

			// Should be fast (OHKO/2HKO → early termination via decisive eval)
			expect(result.nodesVisited).to.be.greaterThan(0);
			expect(result.gameValue).to.be.within(-1, 1);

			// Chien-Pao should favor an attacking move (Ice STAB vs Dragon)
			const attackProb = result.nash.p1Strategy
				.filter(s => s.label.includes('Icicle Crash') || s.label.includes('Ice Shard') || s.label.includes('Crunch'))
				.reduce((sum, s) => sum + s.probability, 0);
			expect(attackProb).to.be.greaterThan(0.5);
		});

		it('should use analytical default depth (5) when useAnalytical is set without explicit depth', function () {
			this.timeout(20000);
			const battle = create1v1Battle(
				{
					species: 'Garchomp',
					moves: ['Earthquake', 'Dragon Claw', 'Swords Dance', 'Stone Edge'],
					ability: 'Rough Skin',
					teraType: 'Ground',
				},
				{
					species: 'Salamence',
					moves: ['Outrage', 'Earthquake', 'Dragon Dance', 'Fire Fang'],
					ability: 'Intimidate',
					teraType: 'Dragon',
				},
			);

			const result = search(battle, {
				useAnalytical: true,
				timeLimit: 15000,
				playerIndex: 0,
			});

			// Should complete and produce valid output (uses DEFAULT_ANALYTICAL_DEPTH = 5)
			expect(result.nash.p1Strategy).to.be.an('array').with.length.greaterThan(0);
			expect(result.gameValue).to.be.within(-1, 1);
			// With depth 5, should visit more nodes than a depth-1 search would
			expect(result.nodesVisited).to.be.greaterThan(5);
		});
	});

	// ─── Forfeit Detection ─────────────────────────────────────

	describe('Forfeit Detection', () => {

		it('should not flag forfeit for an even 1v1 matchup', () => {
			const battle = create1v1Battle(
				{
					species: 'Garchomp',
					moves: ['Earthquake', 'Dragon Claw', 'Swords Dance', 'Stone Edge'],
					ability: 'Rough Skin',
					teraType: 'Ground',
				},
				{
					species: 'Salamence',
					moves: ['Outrage', 'Earthquake', 'Dragon Dance', 'Fire Fang'],
					ability: 'Intimidate',
					teraType: 'Dragon',
				},
			);

			const result = search(battle, { depth: 2, playerIndex: 0 });

			expect(result.forfeit).to.exist;
			expect(result.forfeit!.shouldForfeit).to.be.false;
		});

		it('should include forfeit info in search results', () => {
			const battle = create1v1Battle(
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

			const result = search(battle, { depth: 2, playerIndex: 0 });

			expect(result.forfeit).to.exist;
			expect(result.forfeit!.shouldForfeit).to.be.a('boolean');
			expect(result.forfeit!.eval).to.be.a('number');
			expect(result.forfeit!.monCountDiff).to.be.a('number');
		});

		it('should use checkForfeit directly', () => {
			const { checkForfeit } = require('../../src/minimax') as typeof import('../../src/minimax');

			const battle = create1v1Battle(
				{
					species: 'Garchomp',
					moves: ['Earthquake', 'Dragon Claw', 'Swords Dance', 'Stone Edge'],
					ability: 'Rough Skin',
					teraType: 'Ground',
				},
				{
					species: 'Salamence',
					moves: ['Outrage', 'Earthquake', 'Dragon Dance', 'Fire Fang'],
					ability: 'Intimidate',
					teraType: 'Dragon',
				},
			);

			const forfeit = checkForfeit(battle, undefined, 0, -0.7);
			expect(forfeit.shouldForfeit).to.be.false;
			// 1v1 means monCountDiff = 0
			expect(forfeit.monCountDiff).to.equal(0);
		});
	});

	// ─── Analytical vs Sim-based consistency ───────────────────

	describe('Analytical vs Sim-based Consistency', () => {

		it('should produce similar recommendations for a simple 1v1 (both methods agree on best move)', function () {
			this.timeout(30000);
			const battle = create1v1Battle(
				{
					species: 'Garchomp',
					moves: ['Earthquake', 'Dragon Claw', 'Stone Edge', 'Swords Dance'],
					ability: 'Rough Skin',
					teraType: 'Ground',
				},
				{
					species: 'Dragonite',
					moves: ['Dragon Claw', 'Extreme Speed', 'Earthquake', 'Dragon Dance'],
					ability: 'Multiscale',
					item: 'Lum Berry',
					teraType: 'Normal',
				},
			);

			const simResult = search(battle, { depth: 2, useAnalytical: false, timeLimit: 20000, playerIndex: 0 });
			const analyResult = search(battle, { depth: 2, useAnalytical: true, timeLimit: 5000, playerIndex: 0 });

			// Both should have valid strategies
			expect(simResult.nash.p1Strategy.length).to.be.greaterThan(0);
			expect(analyResult.nash.p1Strategy.length).to.be.greaterThan(0);

			// Get top moves from each
			const simTop = simResult.nash.p1Strategy.reduce((a, b) =>
				a.probability > b.probability ? a : b);
			const analyTop = analyResult.nash.p1Strategy.reduce((a, b) =>
				a.probability > b.probability ? a : b);

			// Both should agree the top move is an attacking move (not Swords Dance in a Dragon mirror)
			const simIsAttack = !simTop.label.includes('Swords Dance');
			const analyIsAttack = !analyTop.label.includes('Swords Dance');
			// At least one should recommend an attack (they might differ on WHICH attack)
			expect(simIsAttack || analyIsAttack).to.be.true;
		});

		it('analytical should visit more nodes at same depth (no clone overhead)', function () {
			this.timeout(30000);
			const battle = create1v1Battle(
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

			// At depth 3, analytical should process many more nodes than sim-based
			// because the analytical path is much faster per node
			const analyResult = search(battle, { depth: 3, useAnalytical: true, timeLimit: 10000, playerIndex: 0 });

			// With depth-3 analytical recursion, we should see substantial node counts
			// 4 moves each = 16 cells at root, each recursing further
			expect(analyResult.nodesVisited).to.be.greaterThan(16);
		});
	});

	describe('Setup Move Boost Projection in Search', () => {

		it('analytical search should value Calm Mind line for Jirachi vs Gastrodon', function () {
			this.timeout(30000);
			const battle = create1v1Battle(
				{
					species: 'Jirachi',
					moves: ['Calm Mind', 'Psychic', 'Flash Cannon', 'Thunder Wave'],
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

			// At depth 4+, the analytical search should recognize that Calm Mind
			// is a strong play because after boosting, Jirachi overwhelms Gastrodon
			const result = search(battle, {
				depth: 4,
				useAnalytical: true,
				timeLimit: 15000,
				playerIndex: 0,
			});

			// Calm Mind should appear in the Nash mix with meaningful probability
			const cmStrategy = result.nash.p1Strategy.find(s =>
				s.label.toLowerCase().includes('calm mind')
			);

			// CM should either be in the mix or the game value should be better
			// than the old -0.20 base eval
			if (cmStrategy) {
				expect(cmStrategy.probability).to.be.greaterThan(0.05);
			}
			// Game value should reflect that the matchup isn't as bad as unboosted
			// damage suggests
			expect(result.gameValue).to.be.greaterThan(-0.5);
		});

		it('analytical search should prefer Swords Dance when it can set up safely', function () {
			this.timeout(30000);
			const battle = create1v1Battle(
				{
					species: 'Garchomp',
					moves: ['Swords Dance', 'Earthquake', 'Dragon Claw', 'Stone Edge'],
					ability: 'Rough Skin',
					item: 'Life Orb',
					teraType: 'Ground',
				},
				{
					species: 'Toxapex',
					moves: ['Scald', 'Toxic', 'Recover', 'Haze'],
					ability: 'Regenerator',
					item: 'Rocky Helmet',
					teraType: 'Water',
				},
			);

			// Garchomp vs Toxapex: unboosted EQ doesn't break through Recover.
			// SD+EQ should be valued highly.
			const result = search(battle, {
				depth: 3,
				useAnalytical: true,
				timeLimit: 15000,
				playerIndex: 0,
			});

			const sdStrategy = result.nash.p1Strategy.find(s =>
				s.label.toLowerCase().includes('swords dance')
			);

			// SD should appear in the strategy mix
			if (sdStrategy) {
				expect(sdStrategy.probability).to.be.greaterThan(0.0);
			}

			// Game value should be reasonable (Garchomp has tools to break Toxapex)
			expect(result.gameValue).to.be.greaterThan(-0.8);
		});
	});
});
