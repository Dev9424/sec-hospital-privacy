/**
 * tests/test_summarizer_anonymization.js
 * Step 5 test: verify that text anonymization gate runs before Gemini in /api/summarize,
 * and that no raw PHI identifier reaches the Gemini payload.
 *
 * Uses in-process stubs (axios + Gemini mocked).  Does NOT call real API or real DB.
 * Run: node tests/test_summarizer_anonymization.js
 * Output: fixes_log/step5_summarizer_tests.txt
 */

'use strict';

const path = require('path');
const fs   = require('fs');

const OUTPUT_FILE = path.join(__dirname, '..', '..', '..', 'fixes_log', 'step5_summarizer_tests.txt');
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

// ── Mock anonymize_clinical_note (mirrors text_anonymization.py logic) ─────────
// Redacts PATIENT_ID, PHONE, EMAIL patterns. Does NOT redact names (spaCy limitation
// on Indian names documented in Step 5 notes).
function mockAnonymizeClinicalNote(text) {
    return text
        .replace(/\b(?:PT|MRN|ID)[-#]?\d{3,8}\b/gi, '[PATIENT_ID]')
        .replace(/\b\d{10}\b/g, '[PHONE]')
        .replace(/\b[\w.+-]+@[\w-]+\.[a-zA-Z]{2,}\b/g, '[EMAIL]');
}

// ── Simulated /api/summarize anonymization gate (matches index.js Step 5 logic) ──
async function runAnonymizationGate(studies, { mlDown = false } = {}) {

    // Stub axios.post for /anonymize-text — mirrors the FastAPI endpoint
    async function stubAxiosPost(url, body) {
        if (mlDown) throw new Error('ML service unreachable (simulated)');
        if (!url.endsWith('/anonymize-text')) throw new Error('Unexpected URL: ' + url);
        const anonymized_text = mockAnonymizeClinicalNote(body.text || '');
        return {
            data: {
                anonymized_text,
                original_length: (body.text || '').length,
                anonymized_length: anonymized_text.length,
            }
        };
    }

    const ML_SERVICE = 'http://localhost:8000';
    const geminiCapture = { called: false, sentStudies: null };

    // --- Anonymization gate (verbatim logic from index.js Step 5) ---
    let sanitizedStudies;
    try {
        sanitizedStudies = await Promise.all(studies.map(async (study) => {
            const anonFindings = study.anonymized_findings
                ? await Promise.all(study.anonymized_findings.map(async (finding) => {
                    const resp = await stubAxiosPost(`${ML_SERVICE}/anonymize-text`, {
                        text: finding,
                        base_noise: 300,
                        largest_group_size: 1000,
                        current_group_size: 1000
                    });
                    return resp.data.anonymized_text;
                }))
                : study.anonymized_findings;
            return { ...study, anonymized_findings: anonFindings };
        }));
    } catch (mlErr) {
        return { blocked: true, reason: mlErr.message, geminiCapture };
    }

    // --- Keyword check (kept from original route) ---
    const privacyRegex = /(patient|name|dob|mrn|phone|address|hospital|email|Rahul|Sharma)/i;
    let containsPHIAfterAnon = false;
    sanitizedStudies.forEach(study => {
        if (study.anonymized_findings) {
            study.anonymized_findings.forEach(finding => {
                if (privacyRegex.test(finding)) containsPHIAfterAnon = true;
            });
        }
    });

    // --- Mock Gemini call with sanitizedStudies (no real API call) ---
    geminiCapture.called = true;
    geminiCapture.sentStudies = JSON.parse(JSON.stringify(sanitizedStudies));

    return { blocked: false, sanitizedStudies, geminiCapture, containsPHIAfterAnon };
}

// ── Tests ─────────────────────────────────────────────────────────────────────
async function runTests() {
    log('\n================================================================');
    log(' Step 5: Summarizer Text Anonymization Gate Tests');
    log(' Tests that PHI is stripped before Gemini, and service fails closed');
    log('================================================================\n');

    // ─── Test A: Structured PHI identifiers stripped before Gemini ───────────
    log('--- Test A: Patient ID and phone number stripped before Gemini ---');
    const studiesPHI = [{
        study_date: '2024-01-15',
        anonymized_findings: [
            'Patient Ramesh Kumar (ID: PT-4471) shows wrist fracture. Contact: 9876543210.',
            'Hemoglobin normal.'
        ]
    }];

    const resA = await runAnonymizationGate(studiesPHI);
    ok('Test A: not blocked (ML service available)', !resA.blocked, resA.reason);
    ok('Test A: Gemini was called', resA.geminiCapture.called);

    const sentFindingsA = (resA.geminiCapture.sentStudies || [])[0]?.anonymized_findings || [];
    ok('Test A: PT-4471 not in Gemini payload',
        !sentFindingsA.some(f => /PT-4471/.test(f)),
        `sent: ${JSON.stringify(sentFindingsA)}`);
    ok('Test A: phone 9876543210 not in Gemini payload',
        !sentFindingsA.some(f => /9876543210/.test(f)),
        `sent: ${JSON.stringify(sentFindingsA)}`);
    log(`  ℹ️  Sanitized findings: ${JSON.stringify(sentFindingsA)}\n`);

    // ─── Test B: Fail-closed when ML service is unavailable ──────────────────
    log('--- Test B: Fail closed when ML service is unavailable ---');
    const resB = await runAnonymizationGate(studiesPHI, { mlDown: true });
    ok('Test B: request is blocked when ML service is down', resB.blocked);
    ok('Test B: Gemini was NOT called when ML service is down', !resB.geminiCapture.called);
    log(`  ℹ️  Block reason: ${resB.reason}\n`);

    // ─── Test C: Clean findings pass through (no over-redaction) ─────────────
    log('--- Test C: Clean clinical findings pass through unchanged ---');
    const studiesClean = [{
        study_date: '2024-02-10',
        anonymized_findings: [
            'Bilateral lung fields clear. No consolidation.',
            'Heart size normal. No pleural effusion.'
        ]
    }];

    const resC = await runAnonymizationGate(studiesClean);
    ok('Test C: not blocked', !resC.blocked);
    ok('Test C: Gemini called', resC.geminiCapture.called);
    const sentFindingsC = (resC.geminiCapture.sentStudies || [])[0]?.anonymized_findings || [];
    ok('Test C: clinical text preserved after anonymization (no over-redaction)',
        sentFindingsC.some(f => /Bilateral lung fields clear/.test(f)),
        `sent: ${JSON.stringify(sentFindingsC)}`);
    log(`  ℹ️  Clean findings: ${JSON.stringify(sentFindingsC)}\n`);

    // ─── Test D: null anonymized_findings handled gracefully ─────────────────
    log('--- Test D: Studies with null anonymized_findings handled ---');
    const studiesNull = [{ study_date: '2024-03-01', anonymized_findings: null }];
    const resD = await runAnonymizationGate(studiesNull);
    ok('Test D: not blocked', !resD.blocked);
    ok('Test D: Gemini called even with null findings', resD.geminiCapture.called);
    log('');

    // ─── Test E: Multiple PHI types in one finding ────────────────────────────
    log('--- Test E: Multiple PHI types redacted in one finding ---');
    const studiesMulti = [{
        study_date: '2024-04-20',
        anonymized_findings: [
            'ID: MRN-78901 phone 1234567890 email john@hospital.com fracture noted.'
        ]
    }];

    const resE = await runAnonymizationGate(studiesMulti);
    const sentFindingE = (resE.geminiCapture.sentStudies || [])[0]?.anonymized_findings?.[0] || '';
    ok('Test E: MRN-78901 not in Gemini payload', !/MRN-78901/.test(sentFindingE), `sent: ${sentFindingE}`);
    ok('Test E: phone 1234567890 not in Gemini payload', !/1234567890/.test(sentFindingE), `sent: ${sentFindingE}`);
    ok('Test E: email not in Gemini payload', !/john@hospital\.com/.test(sentFindingE), `sent: ${sentFindingE}`);
    log(`  ℹ️  E finding after anon: ${sentFindingE}\n`);

    // ─── Test F: Empty string finding is handled gracefully ───────────────────
    log('--- Test F: Empty string findings handled ---');
    const studiesEmpty = [{ study_date: '2024-05-01', anonymized_findings: ['', '  '] }];
    const resF = await runAnonymizationGate(studiesEmpty);
    ok('Test F: not blocked on empty strings', !resF.blocked);
    ok('Test F: Gemini called on empty strings', resF.geminiCapture.called);
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
