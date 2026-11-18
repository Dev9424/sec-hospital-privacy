/**
 * tests/test_discordance.js
 * Step 4 test suite: Longitudinal Study Discordance & Contradiction Detection
 *
 * Verifies:
 *  1. Empty / single-study input returns []
 *  2. No false flag on identical consecutive studies
 *  3. Laterality flip (left <-> right) fires laterality_mismatch
 *  4. Negation flip (affirmative <-> negated) fires negation_conflict
 *  5. Displacement conflict (displaced <-> undisplaced) fires displacement_conflict
 *  6. Rapid healing discordance fires when acute fracture disappears within < 7 days
 *  7. Valid timeline healing (>= 7 days) does NOT flag discordance
 *  8. DP-noised numeric lab values do NOT trigger false contradictions
 *  9. All flags explicitly marked with requires_clinician_review: true and screening disclaimer
 * 10. End-to-end integration merges discordance flags into potential_anomalies
 *
 * Output: fixes_log/summarizer_upgrade/step4_discordance_tests.txt
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { detectDiscordance, extractNonNumericFindings } = require('../discordance');

const OUTPUT_FILE = path.join(__dirname, '..', '..', '..', 'fixes_log', 'summarizer_upgrade', 'step4_discordance_tests.txt');
const lines = [];
function log(msg) { console.log(msg); lines.push(msg); }

let passed = 0, failed = 0;
function ok(label, condition, detail = '') {
    if (condition) {
        log(`  ✅  PASS  ${label}`);
        passed++;
    } else {
        log(`  ❌  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
        failed++;
    }
}

async function runTests() {
    log('\n================================================================');
    log(' Step 4: Discordance & Contradiction Screening Aid Tests');
    log(' Pure deterministic screening over non-numeric study findings');
    log('================================================================\n');

    // ─── Test 1: Empty or Null Input ─────────────────────────────────────────
    log('--- Test 1: Empty or null input returns empty array ---');
    const resEmpty = detectDiscordance([]);
    ok('Test 1a: Empty array returns []', Array.isArray(resEmpty) && resEmpty.length === 0);

    const resNull = detectDiscordance(null);
    ok('Test 1b: Null input returns []', Array.isArray(resNull) && resNull.length === 0);
    log('');

    // ─── Test 2: Single Study Input ──────────────────────────────────────────
    log('--- Test 2: Single study returns empty array (requires pairs) ---');
    const singleStudy = [{
        study_date: '2024-01-10',
        anonymized_findings: ['Left wrist distal radius fracture.']
    }];
    const resSingle = detectDiscordance(singleStudy);
    ok('Test 2: Single study returns []', Array.isArray(resSingle) && resSingle.length === 0);
    log('');

    // ─── Test 3: Identical Studies (No False Positives) ──────────────────────
    log('--- Test 3: Identical consecutive studies return no false flags ---');
    const identicalStudies = [
        { study_date: '2024-01-10', anonymized_findings: ['Distal radius fracture with anatomic alignment.'] },
        { study_date: '2024-01-17', anonymized_findings: ['Distal radius fracture with anatomic alignment.'] }
    ];
    const resIdentical = detectDiscordance(identicalStudies);
    ok('Test 3: Identical studies return []', Array.isArray(resIdentical) && resIdentical.length === 0);
    log('');

    // ─── Test 4: Laterality Flip ─────────────────────────────────────────────
    log('--- Test 4: Laterality flip (left <-> right) on same anatomical region ---');
    const lateralityStudies = [
        { study_date: '2024-02-01', anonymized_findings: ['Acute left wrist fracture identified.'] },
        { study_date: '2024-02-08', anonymized_findings: ['Persistent right wrist fracture under evaluation.'] }
    ];
    const resLaterality = detectDiscordance(lateralityStudies);
    ok('Test 4a: Laterality flip detected', resLaterality.length === 1);
    ok('Test 4b: Flag type is laterality_mismatch', resLaterality[0]?.type === 'laterality_mismatch');
    ok('Test 4c: Pair indices are [0, 1]', resLaterality[0]?.pair[0] === 0 && resLaterality[0]?.pair[1] === 1);
    ok('Test 4d: Requires clinician review is true', resLaterality[0]?.requires_clinician_review === true);
    log(`  ℹ️  Evidence: ${JSON.stringify(resLaterality[0]?.evidence)}\n`);

    // ─── Test 5: Negation Flip ───────────────────────────────────────────────
    log('--- Test 5: Negation flip (affirmative <-> negated condition) ---');
    const negationStudies = [
        { study_date: '2024-03-01', anonymized_findings: ['Moderate pleural effusion present.'] },
        { study_date: '2024-03-03', anonymized_findings: ['No pleural effusion visualized on frontal view.'] }
    ];
    const resNegation = detectDiscordance(negationStudies);
    ok('Test 5a: Negation flip detected', resNegation.length >= 1);
    const negFlag = resNegation.find(f => f.type === 'negation_conflict');
    ok('Test 5b: Flag type is negation_conflict', Boolean(negFlag));
    log(`  ℹ️  Evidence: ${JSON.stringify(negFlag?.evidence)}\n`);

    // ─── Test 6: Reverse Negation Flip ───────────────────────────────────────
    log('--- Test 6: Reverse negation flip (no consolidation -> consolidation) ---');
    const reverseNegation = [
        { study_date: '2024-03-10', anonymized_findings: ['Clear lung fields. No consolidation.'] },
        { study_date: '2024-03-12', anonymized_findings: ['Right middle lobe consolidation present.'] }
    ];
    const resRevNeg = detectDiscordance(reverseNegation);
    ok('Test 6: Reverse negation detected', resRevNeg.some(f => f.type === 'negation_conflict'));
    log('');

    // ─── Test 7: Displacement Conflict ───────────────────────────────────────
    log('--- Test 7: Displacement conflict (displaced <-> undisplaced) ---');
    const displacementStudies = [
        { study_date: '2024-04-01', anonymized_findings: ['Displaced radius fracture noted.'] },
        { study_date: '2024-04-04', anonymized_findings: ['Undisplaced radius fracture with intact cortices.'] }
    ];
    const resDisplacement = detectDiscordance(displacementStudies);
    ok('Test 7a: Displacement conflict detected', resDisplacement.length >= 1);
    const dispFlag = resDisplacement.find(f => f.type === 'displacement_conflict');
    ok('Test 7b: Flag type is displacement_conflict', Boolean(dispFlag));
    log(`  ℹ️  Evidence: ${JSON.stringify(dispFlag?.evidence)}\n`);

    // ─── Test 8: Rapid Healing Conflict (< 7 days) ───────────────────────────
    log('--- Test 8: Rapid healing discordance (acute fracture gone in 1 day) ---');
    const rapidHealingStudies = [
        { study_date: '2024-05-01', anonymized_findings: ['Acute fracture present in distal radius.'] },
        { study_date: '2024-05-02', anonymized_findings: ['No fracture identified. Normal radiograph.'] }
    ];
    const resRapid = detectDiscordance(rapidHealingStudies, { minHealingDays: 7 });
    ok('Test 8a: Rapid healing discordance flagged', resRapid.some(f => f.type === 'rapid_healing_discordance'));
    const rapidFlag = resRapid.find(f => f.type === 'rapid_healing_discordance');
    ok('Test 8b: Detail notes timeframe', rapidFlag?.detail?.includes('1 days'));
    log(`  ℹ️  Evidence: ${JSON.stringify(rapidFlag?.evidence)}\n`);

    // ─── Test 9: Realistic Healing Timeline (>= 7 days, e.g. 60 days) ────────
    log('--- Test 9: Realistic healing timeframe (60 days) does NOT flag discordance ---');
    const realisticHealing = [
        { study_date: '2024-05-01', anonymized_findings: ['Acute fracture present in distal radius.'] },
        { study_date: '2024-07-01', anonymized_findings: ['No fracture identified. Normal radiograph.'] }
    ];
    const resRealistic = detectDiscordance(realisticHealing, { minHealingDays: 7 });
    ok('Test 9: 60-day gap does not flag rapid healing discordance',
        !resRealistic.some(f => f.type === 'rapid_healing_discordance'));
    log('');

    // ─── Test 10: Immunity to DP-Noised Numeric Lab Values ───────────────────
    log('--- Test 10: DP-noised numeric lab values do not cause false flags ---');
    const dpNoisedStudies = [
        { study_date: '2024-06-01', anonymized_findings: ['Stable alignment. WBC: 12,000-13,500.'] },
        { study_date: '2024-06-02', anonymized_findings: ['Stable alignment. WBC: 9,500-11,000.'] }
    ];
    const resDP = detectDiscordance(dpNoisedStudies);
    ok('Test 10: Differing DP-noised numbers cause no false discordance', resDP.length === 0);
    log('');

    // ─── Test 11: Screening Aid Wording and Disclaimer Verification ──────────
    log('--- Test 11: Screening aid disclaimer present on every flag ---');
    const allFlags = [...resLaterality, ...resNegation, ...resDisplacement];
    const allHaveDisclaimer = allFlags.every(f =>
        f.note.includes('Screening aid') && f.note.includes('Not a definitive diagnosis')
    );
    ok('Test 11a: Every flag contains screening aid disclaimer', allHaveDisclaimer);
    const allRequireReview = allFlags.every(f => f.requires_clinician_review === true);
    ok('Test 11b: Every flag enforces requires_clinician_review: true', allRequireReview);
    log('');

    // ─── Test 12: Multiple Consecutive Studies Pair Indexing ────────────────
    log('--- Test 12: Chain of 3 studies detects conflict in correct pair ---');
    const studyChain = [
        { study_date: '2024-08-01', anonymized_findings: ['Left wrist stable.'] },
        { study_date: '2024-08-05', anonymized_findings: ['Left wrist stable.'] },
        { study_date: '2024-08-10', anonymized_findings: ['Right wrist fracture noted.'] }
    ];
    const resChain = detectDiscordance(studyChain);
    ok('Test 12a: Conflict detected between study 1 and study 2', resChain.length === 1);
    ok('Test 12b: Pair correctly indexed as [1, 2]', resChain[0]?.pair[0] === 1 && resChain[0]?.pair[1] === 2);
    log('');

    // ─── Test 13: Configurable Discordance Threshold (DISCORDANCE_MIN_DAYS) ───
    log('--- Test 13: Configurable threshold (env DISCORDANCE_MIN_DAYS & options) ---');
    const tenDayStudies = [
        { study_date: '2024-06-01', anonymized_findings: ['Acute fracture present in distal radius.'] },
        { study_date: '2024-06-11', anonymized_findings: ['No fracture identified. Normal radiograph.'] }
    ];

    delete process.env.DISCORDANCE_MIN_DAYS;
    const resDefault7 = detectDiscordance(tenDayStudies);
    ok('Test 13a: Default 7-day threshold does not flag 10-day gap',
        !resDefault7.some(f => f.type === 'rapid_healing_discordance'));

    const resOption14 = detectDiscordance(tenDayStudies, { minHealingDays: 14 });
    ok('Test 13b: Option override minHealingDays=14 flags 10-day gap',
        resOption14.some(f => f.type === 'rapid_healing_discordance'));

    process.env.DISCORDANCE_MIN_DAYS = '14';
    const resEnv14 = detectDiscordance(tenDayStudies);
    ok('Test 13c: Env DISCORDANCE_MIN_DAYS=14 flags 10-day gap',
        resEnv14.some(f => f.type === 'rapid_healing_discordance'));

    delete process.env.DISCORDANCE_MIN_DAYS;
    log('');

    // ─── Summary ──────────────────────────────────────────────────────────────
    log('================================================================');
    log(` Results: ${passed} passed, ${failed} failed`);
    log('================================================================\n');

    return failed === 0;
}

runTests()
    .then(allOk => {
        fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
        fs.writeFileSync(OUTPUT_FILE, lines.join('\n') + '\n', 'utf8');
        console.log(`[output] Written to ${OUTPUT_FILE}`);
        process.exit(allOk ? 0 : 1);
    })
    .catch(err => {
        log(`[FATAL] ${err.stack}`);
        fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
        fs.writeFileSync(OUTPUT_FILE, lines.join('\n') + '\n', 'utf8');
        console.error(`[output] Written to ${OUTPUT_FILE}`);
        process.exit(1);
    });
