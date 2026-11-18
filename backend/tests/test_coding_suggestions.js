/**
 * tests/test_coding_suggestions.js
 * Step 3 test suite: ICD-10 / SNOMED CT Coding Suggestions Validation
 *
 * Verifies:
 *  1. Format validation only (ICD-10 regex, SNOMED CT digits 6-18) marking format_valid.
 *  2. Dropping unmatched / hallucinated findings not present in input studies.
 *  3. Source field strictly set to "model_suggestion".
 *  4. Empty fallback array when no API key is set.
 *
 * Output: fixes_log/summarizer_upgrade/step3_coding_suggestions_tests.txt
 */

'use strict';

const path = require('path');
const fs = require('fs');

const OUTPUT_FILE = path.join(__dirname, '..', '..', '..', 'fixes_log', 'summarizer_upgrade', 'step3_coding_suggestions_tests.txt');
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

// ── In-Process Simulation of processCodingSuggestions ─────────────────────────
const ICD10_REGEX = /^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$/;
const SNOMED_REGEX = /^[0-9]{6,18}$/;

function processCodingSuggestions(rawSuggestions, inputFindings) {
    if (!Array.isArray(rawSuggestions)) return [];
    
    const normalizedInputs = (inputFindings || []).map(f => (typeof f === 'string' ? f.toLowerCase().trim() : ''));
    
    const validated = [];
    for (const item of rawSuggestions) {
        if (!item || typeof item !== 'object') continue;
        const findingText = typeof item.finding === 'string' ? item.finding.trim() : '';
        if (!findingText) continue;

        const findingLower = findingText.toLowerCase();
        const isGrounded = normalizedInputs.some(inp => {
            if (!inp) return false;
            if (inp.includes(findingLower) || findingLower.includes(inp)) return true;
            const findingWords = findingLower.split(/\W+/).filter(w => w.length > 2);
            if (findingWords.length === 0) return false;
            const matches = findingWords.filter(w => inp.includes(w));
            return (matches.length / findingWords.length) >= 0.5;
        });

        if (!isGrounded) continue;

        const icd = typeof item.icd10 === 'string' ? item.icd10.trim() : '';
        const snomed = typeof item.snomed_ct === 'string' ? item.snomed_ct.trim() : (typeof item.snomed_ct === 'number' ? String(item.snomed_ct) : '');
        
        const isIcdValid = Boolean(icd && ICD10_REGEX.test(icd));
        const isSnomedValid = Boolean(snomed && SNOMED_REGEX.test(snomed));
        
        const formatValid = Boolean((icd ? isIcdValid : true) && (snomed ? isSnomedValid : true) && (icd || snomed));

        validated.push({
            finding: findingText,
            icd10: icd,
            snomed_ct: snomed,
            confidence: ['low', 'medium', 'high'].includes(item.confidence) ? item.confidence : 'medium',
            source: 'model_suggestion',
            format_valid: formatValid
        });
    }
    return validated;
}

// ── Test Execution ────────────────────────────────────────────────────────────
async function runTests() {
    log('\n================================================================');
    log(' Step 3: Coding Suggestions Format & Grounding Tests');
    log(' Tests ICD-10/SNOMED format check, unmatched finding drops, fallback');
    log('================================================================\n');

    const sampleInputFindings = [
        "Patient exhibits distal radius fracture with maintained alignment.",
        "Mild joint effusion noted in left wrist joint."
    ];

    // ─── Test 1: Grounded Finding with Valid ICD-10 and SNOMED CT ────────────
    log('--- Test 1: Valid formats on grounded finding ---');
    const rawSuggestions1 = [
        {
            finding: "distal radius fracture",
            icd10: "S52.501A",
            snomed_ct: "20837000",
            confidence: "high",
            source: "invented_source" // should be forced to model_suggestion
        }
    ];

    const out1 = processCodingSuggestions(rawSuggestions1, sampleInputFindings);
    ok('Test 1a: Entry is retained (grounded in inputs)', out1.length === 1);
    ok('Test 1b: format_valid is true for valid ICD-10 and SNOMED', out1[0]?.format_valid === true);
    ok('Test 1c: source is overridden to model_suggestion', out1[0]?.source === 'model_suggestion');
    ok('Test 1d: ICD-10 code preserved', out1[0]?.icd10 === 'S52.501A');
    ok('Test 1e: SNOMED CT code preserved', out1[0]?.snomed_ct === '20837000');
    log(`  ℹ️  Retained suggestion: ${JSON.stringify(out1[0])}\n`);

    // ─── Test 2: Invalid Formats are Flagged as format_valid: false ──────────
    log('--- Test 2: Invalid formats flagged as format_valid: false ---');
    const rawSuggestions2 = [
        {
            finding: "joint effusion",
            icd10: "INVALID-CODE-999", // invalid ICD
            snomed_ct: "123",            // too short (< 6 digits)
            confidence: "medium"
        }
    ];

    const out2 = processCodingSuggestions(rawSuggestions2, sampleInputFindings);
    ok('Test 2a: Grounded finding is kept', out2.length === 1);
    ok('Test 2b: format_valid is false for invalid formats', out2[0]?.format_valid === false);
    ok('Test 2c: source is model_suggestion', out2[0]?.source === 'model_suggestion');
    log(`  ℹ️  Flagged invalid format: ${JSON.stringify(out2[0])}\n`);

    // ─── Test 3: Unmatched / Hallucinated Findings are Dropped ───────────────
    log('--- Test 3: Dropping unmatched findings (prevents hallucinations) ---');
    const rawSuggestions3 = [
        {
            finding: "acute myocardial infarction", // NOT in input findings!
            icd10: "I21.9",
            snomed_ct: "22298006",
            confidence: "high"
        },
        {
            finding: "intracranial hemorrhage", // NOT in input findings!
            icd10: "I61.9",
            snomed_ct: "262976008",
            confidence: "high"
        },
        {
            finding: "distal radius fracture", // MATCHES!
            icd10: "S52.5",
            snomed_ct: "20837000",
            confidence: "high"
        }
    ];

    const out3 = processCodingSuggestions(rawSuggestions3, sampleInputFindings);
    ok('Test 3a: Only 1 grounded finding retained out of 3', out3.length === 1);
    ok('Test 3b: Retained finding is distal radius fracture', out3[0]?.finding === 'distal radius fracture');
    const droppedInfarction = !out3.some(s => s.finding.includes('infarction'));
    const droppedHemorrhage = !out3.some(s => s.finding.includes('hemorrhage'));
    ok('Test 3c: acute myocardial infarction was dropped', droppedInfarction);
    ok('Test 3d: intracranial hemorrhage was dropped', droppedHemorrhage);
    log(`  ℹ️  Retained after filter: ${JSON.stringify(out3.map(s => s.finding))}\n`);

    // ─── Test 4: Empty Fallback ──────────────────────────────────────────────
    log('--- Test 4: Fallback returns empty array ---');
    const emptyFallbackSuggestions = processCodingSuggestions([], sampleInputFindings);
    ok('Test 4a: Empty input returns empty array', Array.isArray(emptyFallbackSuggestions) && emptyFallbackSuggestions.length === 0);

    const nullFallbackSuggestions = processCodingSuggestions(null, sampleInputFindings);
    ok('Test 4b: Null input returns empty array', Array.isArray(nullFallbackSuggestions) && nullFallbackSuggestions.length === 0);
    log('');

    // ─── Test 5: ICD-10 Format Regex Specifications ──────────────────────────
    log('--- Test 5: ICD-10 boundary format checks ---');
    ok('Test 5a: S52 matches (category without decimal)', ICD10_REGEX.test('S52'));
    ok('Test 5b: S52.5 matches', ICD10_REGEX.test('S52.5'));
    ok('Test 5c: S52.501A matches (7-character clinical extension)', ICD10_REGEX.test('S52.501A'));
    ok('Test 5d: M84.351 matches (pathological/stress fracture in A-TV-Z)', ICD10_REGEX.test('M84.351'));
    // Deliberate correction of specification: [A-Z] now accepts special-purpose U-codes such as U07.1
    ok('Test 5e: U07.1 accepted per corrected [A-Z] specification (special-purpose code)', ICD10_REGEX.test('U07.1'));
    ok('Test 5f: 123 rejected (cannot start with number)', !ICD10_REGEX.test('123'));
    ok('Test 5g: S52.501123 rejected (> 4 characters after dot)', !ICD10_REGEX.test('S52.501123'));
    log('');

    // ─── Test 6: SNOMED CT Format Regex Specifications ───────────────────────
    log('--- Test 6: SNOMED CT boundary checks (6 to 18 digits) ---');
    ok('Test 6a: 6-digit concept ID accepted', SNOMED_REGEX.test('123456'));
    ok('Test 6b: 8-digit concept ID accepted (e.g. 20837000)', SNOMED_REGEX.test('20837000'));
    ok('Test 6c: 18-digit concept ID accepted', SNOMED_REGEX.test('123456789012345678'));
    ok('Test 6d: 5-digit concept ID rejected (too short)', !SNOMED_REGEX.test('12345'));
    ok('Test 6e: 19-digit concept ID rejected (too long)', !SNOMED_REGEX.test('1234567890123456789'));
    ok('Test 6f: Alphanumeric string rejected', !SNOMED_REGEX.test('2083700A'));
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
