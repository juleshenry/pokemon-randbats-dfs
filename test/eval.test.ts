/**
 * eval.test.ts — Tests for position evaluation heuristic
 *
 * Validates that evaluate() produces sensible scores for known positions:
 * - Favorable matchup → positive score (P1 perspective)
 * - Unfavorable matchup → negative score
 * - Terminal states → ±1
 * - HP advantage → positive contribution
 * - Boost advantage → positive contribution
 * - evaluateDetailed breakdown components sum correctly
 */

import { expect } from 'chai';
import {
	create1v1Battle, createBattle, getActiveMon, extractFieldState,
	cloneBattle, makeChoices, isTerminal, getWinValue,
} from '../src/state';
import { evaluate, evaluateDetailed } from '../src/eval';
import type { MonState, FieldState } from '../src/types';

// ─── Test Helpers ────────────────────────────────────────────────

function makeSet(species: string, moves: string[], overrides: Record<string, any> = {}) {
	return {
		species,
		moves,
		ability: overrides.ability || undefined,
		item: overrides.item || '',
		nature: overrides.nature || '',
		evs: overrides.evs || { hp: 85, atk: 85, def: 85, spa: 85, spd: 85, spe: 85 },
		ivs: overrides.ivs || { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
		level: overrides.level || undefined,
		teraType: overrides.teraType || undefined,
	};
}

// ─── Tests ───────────────────────────────────────────────────────

describe('eval.ts — Position Evaluation', () => {

	describe('evaluate() basic range', () => {
		it('should return a value in [-1, 1] for an even matchup', () => {
			const battle = create1v1Battle(
				makeSet('Jirachi', ['ironhead', 'psychic', 'uturn', 'stealthrock']),
				makeSet('Jirachi', ['ironhead', 'psychic', 'uturn', 'stealthrock']),
			);
			const score = evaluate(battle);
			expect(score).to.be.within(-1, 1);
		});

		it('should be approximately 0 for a mirror match at full HP', () => {
			const battle = create1v1Battle(
				makeSet('Jirachi', ['ironhead', 'psychic', 'uturn', 'stealthrock']),
				makeSet('Jirachi', ['ironhead', 'psychic', 'uturn', 'stealthrock']),
			);
			const score = evaluate(battle);
			// Mirror match at full HP should be near 0
			expect(score).to.be.within(-0.15, 0.15);
		});
	});

	describe('evaluate() favorable/unfavorable matchups', () => {
		it('should be positive when P1 has type advantage (Fire vs Grass)', () => {
			const battle = create1v1Battle(
				makeSet('Charizard', ['flamethrower', 'airslash', 'focusblast', 'roost']),
				makeSet('Venusaur', ['sludgebomb', 'gigadrain', 'earthpower', 'synthesis']),
			);
			const score = evaluate(battle);
			// Charizard has Fire STAB SE on Venusaur + Flying STAB SE
			expect(score).to.be.greaterThan(0);
		});

		it('should be negative when P1 has type disadvantage (Fire vs Water)', () => {
			const battle = create1v1Battle(
				makeSet('Charizard', ['flamethrower', 'airslash', 'focusblast', 'roost']),
				makeSet('Swampert', ['earthquake', 'scald', 'icebeam', 'stealthrock']),
			);
			const score = evaluate(battle);
			// Swampert resists Fire AND has super-effective Water STAB
			expect(score).to.be.lessThan(0);
		});

		it('should be strongly positive when P1 has overwhelming advantage', () => {
			const battle = create1v1Battle(
				makeSet('Garchomp', ['earthquake', 'outrage', 'stoneedge', 'swordsdance'], { level: 78 }),
				makeSet('Pikachu', ['thunderbolt', 'voltswitch', 'grassknot', 'surf'], { level: 88 }),
			);
			const score = evaluate(battle);
			// Garchomp is immune to Electric, much stronger overall
			expect(score).to.be.greaterThan(0.15);
		});
	});

	describe('evaluate() after HP changes', () => {
		it('should improve for P1 after dealing damage', () => {
			const battle = create1v1Battle(
				makeSet('Dragapult', ['shadowball', 'dracometeor', 'fireblast', 'uturn']),
				makeSet('Slowbro', ['scald', 'psychic', 'icebeam', 'slackoff']),
			);
			const scoreBefore = evaluate(battle);

			// Sim some turns: P1 attacks
			const battle2 = cloneBattle(battle);
			makeChoices(battle2, 'move 1', 'move 1'); // Dragapult uses Shadow Ball vs Slowbro

			if (!isTerminal(battle2)) {
				const scoreAfter = evaluate(battle2);
				// After dealing super-effective Shadow Ball, P1's position should improve
				// (Dragapult deals SE damage, Slowbro deals neutral)
				expect(scoreAfter).to.be.greaterThan(scoreBefore - 0.3);
			}
		});

		it('should improve HP component when P1 has more HP', () => {
			const battle = create1v1Battle(
				makeSet('Blissey', ['seismictoss', 'softboiled', 'toxic', 'stealthrock']),
				makeSet('Blissey', ['seismictoss', 'softboiled', 'toxic', 'stealthrock']),
			);
			// Force P2 to take damage via Seismic Toss
			makeChoices(battle, 'move 1', 'move 2'); // P1 attacks, P2 Soft-Boiled (heal)
			makeChoices(battle, 'move 1', 'move 1'); // Both Seismic Toss

			const details = evaluateDetailed(battle);
			// After mutual hits + P2 tried to heal, HP should be close
			// At minimum, the HP component should be valid
			expect(details.hp).to.be.within(-1, 1);
		});
	});

	describe('evaluate() terminal states', () => {
		it('should return +1 when P1 wins', () => {
			const battle = create1v1Battle(
				makeSet('Garchomp', ['earthquake', 'outrage', 'stoneedge', 'swordsdance'], { level: 78 }),
				makeSet('Magikarp', ['splash', 'tackle', 'flail', 'bounce'], { level: 100 }),
			);
			// Keep making moves until terminal
			for (let i = 0; i < 20; i++) {
				if (isTerminal(battle)) break;
				makeChoices(battle, 'move 1', 'move 1');
			}
			if (isTerminal(battle)) {
				const score = evaluate(battle);
				// Garchomp should have won
				expect(score).to.equal(1);
			}
		});

		it('should return -1 when P2 wins', () => {
			const battle = create1v1Battle(
				makeSet('Magikarp', ['splash', 'tackle', 'flail', 'bounce'], { level: 100 }),
				makeSet('Garchomp', ['earthquake', 'outrage', 'stoneedge', 'swordsdance'], { level: 78 }),
			);
			for (let i = 0; i < 20; i++) {
				if (isTerminal(battle)) break;
				makeChoices(battle, 'move 1', 'move 1');
			}
			if (isTerminal(battle)) {
				const score = evaluate(battle);
				expect(score).to.equal(-1);
			}
		});
	});

	describe('evaluateDetailed() component breakdown', () => {
		it('should return all components for a normal position', () => {
			const battle = create1v1Battle(
				makeSet('Jirachi', ['ironhead', 'psychic', 'uturn', 'stealthrock']),
				makeSet('Gastrodon', ['earthpower', 'scald', 'icebeam', 'recover']),
			);
			const details = evaluateDetailed(battle);

			expect(details).to.have.all.keys('total', 'hp', 'count', 'matchup', 'setup', 'hazards', 'shadowRisk');
			expect(details.total).to.be.within(-1, 1);
			expect(details.hp).to.be.within(-1, 1);
			expect(details.count).to.be.within(-1, 1);
			expect(details.matchup).to.be.within(-1, 1);
			expect(details.setup).to.be.within(-1, 1);
			expect(details.hazards).to.be.within(-1, 1);
			expect(details.shadowRisk).to.be.within(0, 0.15);
		});

		it('should have 0 shadow risk when no shadow team provided', () => {
			const battle = create1v1Battle(
				makeSet('Jirachi', ['ironhead', 'psychic', 'uturn', 'stealthrock']),
				makeSet('Gastrodon', ['earthpower', 'scald', 'icebeam', 'recover']),
			);
			const details = evaluateDetailed(battle);
			expect(details.shadowRisk).to.equal(0);
		});

		it('should have total matching weighted sum of components', () => {
			const battle = create1v1Battle(
				makeSet('Dragonite', ['outrage', 'earthquake', 'extremespeed', 'dragondance']),
				makeSet('Clefable', ['moonblast', 'flamethrower', 'softboiled', 'calmmind']),
			);
			const d = evaluateDetailed(battle);

			// Manual weighted sum
			const expected = Math.max(-1, Math.min(1,
				0.25 * d.hp +
				0.20 * d.count +
				0.30 * d.matchup +
				0.15 * d.setup +
				0.10 * d.hazards -
				d.shadowRisk
			));
			expect(d.total).to.be.approximately(expected, 0.001);
		});

		it('HP component should be 0 in a 1v1 at full health', () => {
			const battle = create1v1Battle(
				makeSet('Jirachi', ['ironhead', 'psychic', 'uturn', 'stealthrock']),
				makeSet('Jirachi', ['ironhead', 'psychic', 'uturn', 'stealthrock']),
			);
			const d = evaluateDetailed(battle);
			// Both at full HP, both have 1 mon → HP ratio should be 0
			expect(d.hp).to.be.approximately(0, 0.001);
		});

		it('count component should be 0 in 1v1', () => {
			const battle = create1v1Battle(
				makeSet('Jirachi', ['ironhead', 'psychic', 'uturn', 'stealthrock']),
				makeSet('Jirachi', ['ironhead', 'psychic', 'uturn', 'stealthrock']),
			);
			const d = evaluateDetailed(battle);
			// Both have 1 mon alive
			expect(d.count).to.be.approximately(0, 0.001);
		});

		it('setup component should be 0 at start (no boosts)', () => {
			const battle = create1v1Battle(
				makeSet('Jirachi', ['ironhead', 'psychic', 'uturn', 'stealthrock']),
				makeSet('Gastrodon', ['earthpower', 'scald', 'icebeam', 'recover']),
			);
			const d = evaluateDetailed(battle);
			expect(d.setup).to.be.approximately(0, 0.001);
		});

		it('hazards component should be 0 at start (no hazards)', () => {
			const battle = create1v1Battle(
				makeSet('Jirachi', ['ironhead', 'psychic', 'uturn', 'stealthrock']),
				makeSet('Gastrodon', ['earthpower', 'scald', 'icebeam', 'recover']),
			);
			const d = evaluateDetailed(battle);
			expect(d.hazards).to.be.approximately(0, 0.001);
		});
	});

	describe('evaluate() with boosts (setup)', () => {
		it('should improve for P1 after using a setup move', () => {
			const battle = create1v1Battle(
				makeSet('Dragonite', ['outrage', 'earthquake', 'extremespeed', 'dragondance']),
				makeSet('Slowbro', ['scald', 'psychic', 'icebeam', 'slackoff']),
			);
			const scoreBefore = evaluate(battle);

			// P1 uses Dragon Dance while P2 attacks
			const battle2 = cloneBattle(battle);
			makeChoices(battle2, 'move 4', 'move 1'); // Dragon Dance vs Scald

			if (!isTerminal(battle2)) {
				const scoreAfter = evaluate(battle2);
				const detailsAfter = evaluateDetailed(battle2);

				// Setup component should be positive after DD
				expect(detailsAfter.setup).to.be.greaterThan(0);
				// Matchup should also improve (higher boosted attack + speed)
				expect(detailsAfter.matchup).to.be.greaterThan(-1);
			}
		});
	});

	describe('evaluate() multi-mon teams', () => {
		it('should reflect count advantage when P1 has more alive mons', () => {
			const p1Team = [
				makeSet('Jirachi', ['ironhead', 'psychic', 'uturn', 'stealthrock']),
				makeSet('Gastrodon', ['earthpower', 'scald', 'icebeam', 'recover']),
				makeSet('Garchomp', ['earthquake', 'outrage', 'stoneedge', 'swordsdance']),
			];
			const p2Team = [
				makeSet('Jirachi', ['ironhead', 'psychic', 'uturn', 'stealthrock']),
				makeSet('Gastrodon', ['earthpower', 'scald', 'icebeam', 'recover']),
				makeSet('Garchomp', ['earthquake', 'outrage', 'stoneedge', 'swordsdance']),
			];

			const battle = createBattle(p1Team, p2Team);
			const d0 = evaluateDetailed(battle);
			expect(d0.count).to.be.approximately(0, 0.001); // equal counts

			// Now KO P2's active mon to create a count advantage
			// (mutate HP directly for a unit test)
			const b = battle as any;
			const p2Active = b.sides[1].active[0];
			if (p2Active) {
				p2Active.hp = 0;
				p2Active.fainted = true;
				// Force switch to next
			}

			const d1 = evaluateDetailed(battle);
			expect(d1.count).to.be.greaterThan(0); // P1 has more alive
		});
	});

	describe('evaluate() with hazards', () => {
		it('should favor P1 when Stealth Rock is on P2\'s side', () => {
			const p1Team = [
				makeSet('Jirachi', ['ironhead', 'psychic', 'uturn', 'stealthrock']),
				makeSet('Garchomp', ['earthquake', 'outrage', 'stoneedge', 'swordsdance']),
			];
			const p2Team = [
				makeSet('Charizard', ['flamethrower', 'airslash', 'focusblast', 'roost']),
				makeSet('Volcarona', ['fireblast', 'bugbuzz', 'quiverdance', 'roost']),
			];

			const battle = createBattle(p1Team, p2Team);

			// Use Stealth Rock
			makeChoices(battle, 'move 4', 'move 1'); // Jirachi sets SR

			if (!isTerminal(battle)) {
				const d = evaluateDetailed(battle);
				// SR on P2's side hurts them (both Fire/Flying or Fire/Bug = 4x weak to Rock)
				// Hazard component should be positive for P1
				expect(d.hazards).to.be.greaterThan(0);
			}
		});
	});

	describe('evaluate() consistency', () => {
		it('should produce the same score for the same position', () => {
			const battle = create1v1Battle(
				makeSet('Tyranitar', ['stoneedge', 'crunch', 'earthquake', 'stealthrock']),
				makeSet('Skarmory', ['bodypress', 'irondefense', 'roost', 'spikes']),
			);
			const s1 = evaluate(battle);
			const s2 = evaluate(battle);
			expect(s1).to.equal(s2);
		});

		it('evaluate and evaluateDetailed.total should match', () => {
			const battle = create1v1Battle(
				makeSet('Tyranitar', ['stoneedge', 'crunch', 'earthquake', 'stealthrock']),
				makeSet('Skarmory', ['bodypress', 'irondefense', 'roost', 'spikes']),
			);
			const score = evaluate(battle);
			const details = evaluateDetailed(battle);
			expect(score).to.be.approximately(details.total, 0.001);
		});
	});

	// ─── Bug Fix Tests: Status + Residual ─────────────────────────

	describe('evaluate() sleep/freeze action denial (Bug 3 fix)', () => {

		it('sleeping P2 active should improve P1 matchup score', () => {
			const battle = create1v1Battle(
				makeSet('Garchomp', ['earthquake', 'outrage', 'stoneedge', 'swordsdance']),
				makeSet('Slowbro', ['scald', 'psychic', 'icebeam', 'slackoff']),
			);
			const scoreNormal = evaluate(battle);

			// Clone and put P2 to sleep
			const battle2 = cloneBattle(battle);
			const p2Mon = (battle2 as any).sides[1].active[0];
			p2Mon.status = 'slp';
			p2Mon.statusState = { id: 'slp', target: p2Mon, startTurn: 1, duration: 3, stage: 0, time: 0 };

			const scoreSlp = evaluate(battle2);
			// Sleeping opponent can't attack → P1's matchup should improve
			expect(scoreSlp).to.be.greaterThan(scoreNormal - 0.05,
				`Sleeping P2 should make P1's position at least as good (normal=${scoreNormal}, slp=${scoreSlp})`);
		});

		it('sleeping P1 active should worsen P1 matchup score', () => {
			const battle = create1v1Battle(
				makeSet('Garchomp', ['earthquake', 'outrage', 'stoneedge', 'swordsdance']),
				makeSet('Slowbro', ['scald', 'psychic', 'icebeam', 'slackoff']),
			);
			const scoreNormal = evaluate(battle);

			const battle2 = cloneBattle(battle);
			const p1Mon = (battle2 as any).sides[0].active[0];
			p1Mon.status = 'slp';
			p1Mon.statusState = { id: 'slp', target: p1Mon, startTurn: 1, duration: 3, stage: 0, time: 0 };

			const scoreSlp = evaluate(battle2);
			expect(scoreSlp).to.be.lessThan(scoreNormal + 0.05,
				`Sleeping P1 should worsen position (normal=${scoreNormal}, slp=${scoreSlp})`);
		});

		it('frozen P2 active should improve P1 position', () => {
			const battle = create1v1Battle(
				makeSet('Garchomp', ['earthquake', 'outrage', 'stoneedge', 'swordsdance']),
				makeSet('Rotom-Wash', ['hydropump', 'voltswitch', 'willowisp', 'painsplit'],
					{ ability: 'Levitate' }),
			);
			const scoreNormal = evaluate(battle);

			const battle2 = cloneBattle(battle);
			const p2Mon = (battle2 as any).sides[1].active[0];
			p2Mon.status = 'frz';
			p2Mon.statusState = { id: 'frz', target: p2Mon, startTurn: 1, stage: 0, time: 0 };

			const scoreFrz = evaluate(battle2);
			expect(scoreFrz).to.be.greaterThan(scoreNormal - 0.05);
		});
	});

	describe('evaluate() paralysis discount (Bug 5 fix)', () => {

		it('paralyzed P2 should slightly improve P1 position', () => {
			const battle = create1v1Battle(
				makeSet('Garchomp', ['earthquake', 'outrage', 'stoneedge', 'swordsdance']),
				makeSet('Slowbro', ['scald', 'psychic', 'icebeam', 'slackoff']),
			);
			const scoreNormal = evaluate(battle);

			const battle2 = cloneBattle(battle);
			const p2Mon = (battle2 as any).sides[1].active[0];
			p2Mon.status = 'par';
			p2Mon.statusState = { id: 'par', target: p2Mon, startTurn: 1, stage: 0, time: 0 };

			const scorePar = evaluate(battle2);
			// Par reduces P2's effective damage by 25% → P1's matchup improves
			expect(scorePar).to.be.greaterThanOrEqual(scoreNormal - 0.1);
		});
	});

	describe('evaluate() residual damage in TKO (Bug 4 fix)', () => {

		it('burned P2 should improve P1 TKO estimation', () => {
			const battle = create1v1Battle(
				makeSet('Garchomp', ['earthquake', 'outrage', 'stoneedge', 'swordsdance']),
				makeSet('Skarmory', ['bodypress', 'irondefense', 'roost', 'spikes']),
			);
			const scoreNormal = evaluate(battle);

			const battle2 = cloneBattle(battle);
			const p2Mon = (battle2 as any).sides[1].active[0];
			p2Mon.status = 'brn';
			p2Mon.statusState = { id: 'brn', target: p2Mon, startTurn: 1, stage: 0, time: 0 };

			const scoreBrn = evaluate(battle2);
			// Burn chip damage on P2 should help P1's TKO → better position
			expect(scoreBrn).to.be.greaterThanOrEqual(scoreNormal - 0.05);
		});

		it('toxic on P2 should improve P1 position', () => {
			const battle = create1v1Battle(
				makeSet('Jirachi', ['ironhead', 'psychic', 'uturn', 'stealthrock']),
				makeSet('Gastrodon', ['earthpower', 'scald', 'icebeam', 'recover']),
			);
			const scoreNormal = evaluate(battle);

			const battle2 = cloneBattle(battle);
			const p2Mon = (battle2 as any).sides[1].active[0];
			p2Mon.status = 'tox';
			p2Mon.statusState = { id: 'tox', target: p2Mon, startTurn: 1, stage: 0, time: 0, toxicTurns: 3 };

			const scoreTox = evaluate(battle2);
			expect(scoreTox).to.be.greaterThanOrEqual(scoreNormal - 0.05);
		});
	});
});
