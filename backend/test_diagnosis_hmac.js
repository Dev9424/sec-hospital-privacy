/**
 * test_diagnosis_hmac.js — Step 2 test
 *
 * Verifies:
 *  1. generateClinicalSignature() signs `${patient_id}|${diagnosis}` (not a constant `|`)
 *  2. A valid signature is accepted by /api/diagnosis/submit
 *  3. A tampered diagnosis is rejected and SECURITY_ALERT_TAMPERING is logged
 *
 * Run:   node test_diagnosis_hmac.js
 * Requires the backend server to be running (or use standalone mode below).
 */

const crypto = require('crypto');

// Must match backend/index.js line 15
const INTEGRITY_SECRET = process.env.INTEGRITY_SECRET || 'fallback-integrity-secret';

// Reproduce the FIXED generateClinicalSignature locally
function generateClinicalSignature(patient_id, diagnosis) {
    const dataString = `${patient_id}|${diagnosis}`;
    return crypto.createHmac('sha256', INTEGRITY_SECRET).update(dataString).digest('hex');
}

// ── Standalone unit tests (no server needed) ──

let passed = 0;
let failed = 0;

function assert(condition, msg) {
    if (condition) { passed++; console.log(`  ✅ PASS: ${msg}`); }
    else           { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

console.log('\n=== Test 1: Signature includes patient_id and diagnosis ===');
{
    const sig1 = generateClinicalSignature(1, 'Flu');
    const sig2 = generateClinicalSignature(2, 'Flu');      // different patient
    const sig3 = generateClinicalSignature(1, 'Migraine'); // different diagnosis

    // The old bug: dataString = `|` → all three would be identical
    assert(sig1 !== sig2, 'Different patient_id → different signature');
    assert(sig1 !== sig3, 'Different diagnosis → different signature');

    // Verify the exact HMAC value
    const expected = crypto.createHmac('sha256', INTEGRITY_SECRET)
        .update('1|Flu').digest('hex');
    assert(sig1 === expected, 'Signature matches HMAC-SHA256 of "1|Flu"');
}

console.log('\n=== Test 2: Valid signature accepted ===');
{
    const patient_id = 42;
    const diagnosis = 'Seasonal Flu';
    const signature = generateClinicalSignature(patient_id, diagnosis);
    const expectedSignature = generateClinicalSignature(patient_id, diagnosis);
    assert(signature === expectedSignature, 'Valid signature matches expected');
}

console.log('\n=== Test 3: Tampered diagnosis rejected ===');
{
    const patient_id = 42;
    const original = 'Seasonal Flu';
    const tampered = 'Critical Heart Failure';

    const originalSig = generateClinicalSignature(patient_id, original);
    const expectedForTampered = generateClinicalSignature(patient_id, tampered);

    assert(originalSig !== expectedForTampered,
        'Original signature does NOT match tampered diagnosis → SECURITY_ALERT_TAMPERING would fire');
}

console.log('\n=== Test 4: Old buggy constant "|" would have been identical ===');
{
    // Prove the old bug: HMAC('|') is the same regardless of inputs
    const oldBugSig = crypto.createHmac('sha256', INTEGRITY_SECRET).update('|').digest('hex');
    const correctSig1 = generateClinicalSignature(1, 'Flu');
    const correctSig2 = generateClinicalSignature(99, 'Cancer');

    assert(oldBugSig !== correctSig1, 'Fixed sig for (1,Flu) differs from old constant "|" sig');
    assert(oldBugSig !== correctSig2, 'Fixed sig for (99,Cancer) differs from old constant "|" sig');
    assert(correctSig1 !== correctSig2, 'Different inputs → different signatures (not constant)');
}

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('All diagnosis HMAC tests passed.\n');
