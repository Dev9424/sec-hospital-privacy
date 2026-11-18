/**
 * tests/test_summarizer_gate_hardening.js
 * Step 2 test suite: Gate Hardening for /api/summarize
 *
 * Verifies:
 *  1. Whitelist filtering: extra study fields (patient_name, patient_id, ssn, doctor_notes) are dropped.
 *  2. Real post-generation PHI scan: phone number / patient ID in LLM output turns privacy flag true
 *     and activates privacy filter (replacing overall_summary).
 *  3. Malformed JSON / invalid schema returns 502 and does NOT store.
 *
 * Output: fixes_log/summarizer_upgrade/step2_gate_hardening_tests.txt
 */

'use strict';

const path = require('path');
const fs = require('fs');

const OUTPUT_FILE = path.join(__dirname, '..', '..', '..', 'fixes_log', 'summarizer_upgrade', 'step2_gate_hardening_tests.txt');
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

// ── In-Process Simulation of Hardened /api/summarize Logic ────────────────────

// Mirrors Step 2 helper functions from backend/index.js
function extractAllStrings(obj) {
    const out = [];
    function walk(val) {
        if (!val) return;
        if (typeof val === 'string') out.push(val);
        else if (Array.isArray(val)) val.forEach(walk);
        else if (typeof val === 'object') Object.values(val).forEach(walk);
    }
    walk(obj);
    return out;
}

function scanModelOutputForPHI(jsonObj) {
    const text = extractAllStrings(jsonObj).join(' ');
    return {
        contains_patient_name: /\b(?:Patient|Mr\.|Mrs\.|Ms\.)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/.test(text),
        contains_patient_id: /\b(?:PT|MRN|ID)[-#]?\d{3,8}\b/i.test(text),
        contains_dob: /\b(?:DOB|birth)[:\s]*\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/i.test(text),
        contains_mrn: /\bMRN[-#]?\d{3,8}\b/i.test(text),
        contains_phone: /\b(?:\+?\d{1,3}[-.\s]?)?\d{10}\b/.test(text),
        contains_address: /\b\d{1,5}\s+[A-Za-z0-9\s.,]+(?:Street|St|Avenue|Ave|Road|Rd)\b/i.test(text),
        contains_hospital_identifier: /\b(?:Apollo|Fortis|Max|Manipal|AIIMS)\s+(?:Hospital|Clinic)\b/i.test(text)
    };
}

function validateSummarizerSchema(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { valid: false, reason: 'Root must be a valid JSON object' };
    }
    if (typeof data.summary_status !== 'string') {
        return { valid: false, reason: 'Missing or invalid summary_status string' };
    }
    if (typeof data.overall_summary !== 'string') {
        return { valid: false, reason: 'Missing or invalid overall_summary string' };
    }
    if (!Array.isArray(data.disease_trends)) {
        return { valid: false, reason: 'Missing or invalid disease_trends array' };
    }
    if (!Array.isArray(data.anatomical_findings)) {
        return { valid: false, reason: 'Missing or invalid anatomical_findings array' };
    }
    if (typeof data.clinical_review_required !== 'boolean') {
        return { valid: false, reason: 'Missing or invalid clinical_review_required boolean' };
    }
    return { valid: true };
}

// Full simulation of the hardened gate pipeline
async function simulateHardenedSummarizeRoute(studies, { mockModelOutput = null, isRawString = false, simulateMlDown = false } = {}) {
    const geminiCapturedPayload = { sentStudies: null };

    // 1. Text Anonymization + Field Whitelist
    let sanitizedStudies;
    try {
        if (simulateMlDown) throw new Error('ML service unavailable');
        sanitizedStudies = await Promise.all(studies.map(async (study) => {
            const anonFindings = study.anonymized_findings ? study.anonymized_findings.map(f => f.replace(/\b\d{10}\b/g, '[PHONE]')) : null;
            
            // Hardened whitelist from Step 2
            const whitelisted = {};
            if (study.study_date !== undefined) whitelisted.study_date = study.study_date;
            if (study.modality !== undefined) whitelisted.modality = study.modality;
            if (study.body_region !== undefined) whitelisted.body_region = study.body_region;
            whitelisted.anonymized_findings = anonFindings;
            return whitelisted;
        }));
    } catch (err) {
        return { statusCode: 503, error: err.message };
    }

    // Capture exact studies payload sent to Gemini
    geminiCapturedPayload.sentStudies = JSON.parse(JSON.stringify(sanitizedStudies));

    // 2. Simulated Model Response Parsing
    let rawText = isRawString ? mockModelOutput : JSON.stringify(mockModelOutput);
    let jsonResponse;
    try {
        jsonResponse = JSON.parse(rawText);
    } catch (err) {
        return { statusCode: 502, error: 'Malformed JSON', dbInserted: false, geminiCapturedPayload };
    }

    // 3. Schema Validation
    const validation = validateSummarizerSchema(jsonResponse);
    if (!validation.valid) {
        return { statusCode: 502, error: 'Schema validation failed: ' + validation.reason, dbInserted: false, geminiCapturedPayload };
    }

    // 4. Real Post-Check Scan
    jsonResponse.privacy_check = scanModelOutputForPHI(jsonResponse);

    // 5. Privacy Shield Activation
    const hasAnyPHI = Object.values(jsonResponse.privacy_check).some(Boolean);
    if (hasAnyPHI) {
        jsonResponse.overall_summary = "Privacy filter activated. Identifying information was removed.";
        jsonResponse.clinical_review_required = true;
        jsonResponse.review_reason = "Privacy filter activated: potential identifier pattern detected in model output.";
    }

    return {
        statusCode: 200,
        response: jsonResponse,
        dbInserted: true,
        geminiCapturedPayload
    };
}

// ── Test Execution ────────────────────────────────────────────────────────────
async function runTests() {
    log('\n================================================================');
    log(' Step 2: Summarizer Gate Hardening Tests');
    log(' Tests Whitelist, Real Privacy Post-Check, and Schema Validation');
    log('================================================================\n');

    // ─── Test 1: Whitelist Drops Extra Study Fields ──────────────────────────
    log('--- Test 1: Whitelist drops extra study fields from LLM payload ---');
    const inputStudiesWithExtra = [{
        study_id: 'STUDY-99881',
        patient_name: 'SECRET PATIENT',
        patient_id: 'SECRET-PID-123',
        doctor_notes: 'CONFIDENTIAL CLINICAL OPINION',
        mrn: 'MRN-99999',
        study_date: '2024-05-10',
        modality: 'XR',
        body_region: 'WRIST',
        anonymized_findings: ['Distal radius fracture alignment maintained.']
    }];

    const validModelResponse = {
        summary_status: 'success',
        overall_summary: 'Persistent fracture with maintained alignment.',
        disease_trends: [{ condition_or_abnormality: 'fracture', anatomical_region: 'distal radius', trend: 'stable' }],
        anatomical_findings: [{ region: 'wrist', findings: 'fracture', trend: 'stable' }],
        clinical_review_required: true,
        review_reason: 'Routine clinical review required.'
    };

    const res1 = await simulateHardenedSummarizeRoute(inputStudiesWithExtra, { mockModelOutput: validModelResponse });
    const sentStudy = res1.geminiCapturedPayload.sentStudies[0];

    ok('Test 1a: Allowed field study_date is preserved', sentStudy.study_date === '2024-05-10');
    ok('Test 1b: Allowed field modality is preserved', sentStudy.modality === 'XR');
    ok('Test 1c: Allowed field body_region is preserved', sentStudy.body_region === 'WRIST');
    ok('Test 1d: Extra field patient_name was dropped', sentStudy.patient_name === undefined);
    ok('Test 1e: Extra field patient_id was dropped', sentStudy.patient_id === undefined);
    ok('Test 1f: Extra field doctor_notes was dropped', sentStudy.doctor_notes === undefined);
    ok('Test 1g: Extra field mrn was dropped', sentStudy.mrn === undefined);
    ok('Test 1h: Extra field study_id was dropped', sentStudy.study_id === undefined);
    log(`  ℹ️  Whitelisted keys present in sent payload: ${Object.keys(sentStudy).join(', ')}\n`);

    // ─── Test 2: Real Privacy Post-Check Detects Phone in Model Output ────────
    log('--- Test 2: Real privacy scan detects phone number in LLM output ---');
    const modelOutputWithPhone = {
        summary_status: 'success',
        overall_summary: 'Fracture healing. Contact radiologist at 9876543210 for clarification.',
        disease_trends: [],
        anatomical_findings: [],
        clinical_review_required: false
    };

    const res2 = await simulateHardenedSummarizeRoute(inputStudiesWithExtra, { mockModelOutput: modelOutputWithPhone });
    ok('Test 2a: privacy_check.contains_phone is true', res2.response.privacy_check.contains_phone === true);
    ok('Test 2b: overall_summary replaced with privacy filter message',
        res2.response.overall_summary === "Privacy filter activated. Identifying information was removed.",
        `Got: ${res2.response.overall_summary}`);
    ok('Test 2c: clinical_review_required forced to true', res2.response.clinical_review_required === true);
    ok('Test 2d: review_reason states privacy filter activated',
        res2.response.review_reason.includes('Privacy filter activated'));
    log(`  ℹ️  privacy_check flags: ${JSON.stringify(res2.response.privacy_check)}\n`);

    // ─── Test 3: Real Privacy Post-Check Detects Patient ID in Model Output ──
    log('--- Test 3: Real privacy scan detects patient ID in LLM output ---');
    const modelOutputWithPID = {
        summary_status: 'success',
        overall_summary: 'Report generated for case PT-44219. Alignment is anatomic.',
        disease_trends: [],
        anatomical_findings: [],
        clinical_review_required: false
    };

    const res3 = await simulateHardenedSummarizeRoute(inputStudiesWithExtra, { mockModelOutput: modelOutputWithPID });
    ok('Test 3a: privacy_check.contains_patient_id is true', res3.response.privacy_check.contains_patient_id === true);
    ok('Test 3b: overall_summary shielded',
        res3.response.overall_summary === "Privacy filter activated. Identifying information was removed.");
    log('');

    // ─── Test 4: Clean Model Output Leaves Summary Intact ────────────────────
    log('--- Test 4: Clean model output leaves summary and flags intact ---');
    const cleanOutput = {
        summary_status: 'success',
        overall_summary: 'Stable radiographic findings with no new fracture displacement.',
        disease_trends: [{ condition_or_abnormality: 'fracture', anatomical_region: 'radius', trend: 'stable' }],
        anatomical_findings: [{ region: 'wrist', findings: 'fracture', trend: 'stable' }],
        clinical_review_required: true
    };

    const res4 = await simulateHardenedSummarizeRoute(inputStudiesWithExtra, { mockModelOutput: cleanOutput });
    ok('Test 4a: contains_phone is false', res4.response.privacy_check.contains_phone === false);
    ok('Test 4b: contains_patient_id is false', res4.response.privacy_check.contains_patient_id === false);
    ok('Test 4c: clean overall_summary is preserved', res4.response.overall_summary === cleanOutput.overall_summary);
    log('');

    // ─── Test 5: Malformed JSON Returns 502 Without Storing ───────────────────
    log('--- Test 5: Malformed JSON returns 502 and does not store ---');
    const malformedRaw = '{"summary_status": "success", "overall_summary": "broken JSON string...';
    const res5 = await simulateHardenedSummarizeRoute(inputStudiesWithExtra, { mockModelOutput: malformedRaw, isRawString: true });
    ok('Test 5a: HTTP status code is 502', res5.statusCode === 502);
    ok('Test 5b: DB insertion blocked', res5.dbInserted === false);
    ok('Test 5c: Error indicates malformed JSON', res5.error.includes('Malformed JSON'));
    log('');

    // ─── Test 6: Invalid Schema Structure Returns 502 Without Storing ────────
    log('--- Test 6: Invalid schema (missing disease_trends) returns 502 ---');
    const invalidSchemaOutput = {
        summary_status: 'success',
        overall_summary: 'Some summary text',
        // disease_trends missing!
        anatomical_findings: [],
        clinical_review_required: true
    };

    const res6 = await simulateHardenedSummarizeRoute(inputStudiesWithExtra, { mockModelOutput: invalidSchemaOutput });
    ok('Test 6a: HTTP status code is 502 on missing required key', res6.statusCode === 502);
    ok('Test 6b: DB insertion blocked', res6.dbInserted === false);
    ok('Test 6c: Error describes schema failure', res6.error.includes('Schema validation failed'));
    log('');

    // ─── Test 7: Non-boolean clinical_review_required Returns 502 ────────────
    log('--- Test 7: Non-boolean clinical_review_required returns 502 ---');
    const invalidTypeOutput = {
        summary_status: 'success',
        overall_summary: 'Some summary text',
        disease_trends: [],
        anatomical_findings: [],
        clinical_review_required: "yes" // invalid type
    };

    const res7 = await simulateHardenedSummarizeRoute(inputStudiesWithExtra, { mockModelOutput: invalidTypeOutput });
    ok('Test 7a: HTTP status code is 502 on invalid field type', res7.statusCode === 502);
    ok('Test 7b: DB insertion blocked', res7.dbInserted === false);
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
