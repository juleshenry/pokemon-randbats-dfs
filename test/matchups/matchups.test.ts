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
});
