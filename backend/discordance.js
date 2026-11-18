/**
 * discordance.js
 * ==============
 * Pure, deterministic discordance and contradiction detector between consecutive clinical studies.
 *
 * IMPORTANT:
 * This module is a SCREENING AID that flags potential documentation discrepancies
 * for authorized clinician review. It is NOT a diagnostic tool and does NOT make
 * clinical determinations.
 *
 * Operates strictly on non-numeric clinical text to avoid false positives from
 * differential-privacy noised numeric values.
 */

'use strict';

// Step 4: Named constant for minimum healing days, read from env DISCORDANCE_MIN_DAYS, default 7
const DISCORDANCE_MIN_DAYS = (!isNaN(parseInt(process.env.DISCORDANCE_MIN_DAYS, 10)) && parseInt(process.env.DISCORDANCE_MIN_DAYS, 10) > 0)
    ? parseInt(process.env.DISCORDANCE_MIN_DAYS, 10)
    : 7;

function getDiscordanceMinDays() {
    const parsed = parseInt(process.env.DISCORDANCE_MIN_DAYS, 10);
    return (!isNaN(parsed) && parsed > 0) ? parsed : 7;
}

const ANATOMICAL_REGIONS = [
    'wrist', 'radius', 'ulna', 'scaphoid', 'femur', 'tibia', 'fibula',
    'ankle', 'humerus', 'clavicle', 'shoulder', 'elbow', 'knee', 'hip',
    'lung', 'hemithorax', 'chest', 'rib', 'patella', 'hand', 'foot'
];

/**
 * Parse an ISO date or YYYY-MM-DD string into a Date object.
 */
function parseDate(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return null;
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? null : d;
}

/**
 * Calculate difference in days between two dates.
 */
function daysBetween(dateA, dateB) {
    if (!dateA || !dateB) return null;
    const msDiff = Math.abs(dateB.getTime() - dateA.getTime());
    return msDiff / (1000 * 60 * 60 * 24);
}

/**
 * Extract clean, non-numeric sentences/findings from a study.
 * Strips out numeric DP-noised lab values (e.g. WBC: 12,000-13,500) to avoid false contradictions.
 */
function extractNonNumericFindings(study) {
    if (!study || !Array.isArray(study.anonymized_findings)) return [];
    const cleaned = [];
    for (const f of study.anonymized_findings) {
        if (typeof f !== 'string' || !f.trim()) continue;
        // Strip lab values like "WBC: 10,000-12,000" or numeric patterns
        const stripped = f
            .replace(/\b(?:WBC|RBC|Platelets?|Hemoglobin|Hb|Glucose)\s*[:\-]?\s*[\d,.\s\-]+/gi, '')
            .trim();
        if (stripped.length > 0) {
            cleaned.push(stripped);
        }
    }
    return cleaned;
}

/**
 * Detect laterality flips (left <-> right) on the same anatomical region.
 */
function checkLateralityFlip(findingsA, findingsB) {
    for (const fA of findingsA) {
        const lowerA = fA.toLowerCase();
        const hasLeftA = /\bleft\b/i.test(lowerA);
        const hasRightA = /\bright\b/i.test(lowerA);
        if (!hasLeftA && !hasRightA) continue;

        for (const fB of findingsB) {
            const lowerB = fB.toLowerCase();
            const hasLeftB = /\bleft\b/i.test(lowerB);
            const hasRightB = /\bright\b/i.test(lowerB);
            if (!hasLeftB && !hasRightB) continue;

            // Check if they reference the same anatomical region
            const sharedRegion = ANATOMICAL_REGIONS.find(r => lowerA.includes(r) && lowerB.includes(r));
            if (sharedRegion) {
                if ((hasLeftA && hasRightB) || (hasRightA && hasLeftB)) {
                    return {
                        type: 'laterality_mismatch',
                        evidence: [fA, fB],
                        detail: `Laterality changed for ${sharedRegion} between consecutive studies (${hasLeftA ? 'left' : 'right'} vs ${hasLeftB ? 'left' : 'right'})`
                    };
                }
            }
        }
    }
    return null;
}

/**
 * Detect direct negation flips on key clinical observations.
 * E.g., "effusion" <-> "no effusion", "consolidation" <-> "no consolidation", "pneumothorax" <-> "no pneumothorax".
 */
function checkNegationFlip(findingsA, findingsB) {
    const KEY_CONDITIONS = ['effusion', 'pneumothorax', 'consolidation', 'edema', 'dislocation', 'infiltrate'];

    for (const condition of KEY_CONDITIONS) {
        const regexNegative = new RegExp(`\\b(?:no|without|negative for)\\s+(?:\\w+\\s+){0,3}${condition}\\b`, 'i');
        const conditionMentioned = new RegExp(`\\b${condition}\\b`, 'i');

        for (const fA of findingsA) {
            if (!conditionMentioned.test(fA)) continue;
            const isNegA = regexNegative.test(fA);
            const isPosA = !isNegA;

            for (const fB of findingsB) {
                if (!conditionMentioned.test(fB)) continue;
                const isNegB = regexNegative.test(fB);
                const isPosB = !isNegB;

                if ((isPosA && isNegB) || (isNegA && isPosB)) {
                    return {
                        type: 'negation_conflict',
                        evidence: [fA, fB],
                        detail: `Contradictory documentation of ${condition}: affirmative vs negated state`
                    };
                }
            }
        }
    }
    return null;
}

/**
 * Detect displacement state flips (displaced <-> undisplaced / non-displaced).
 */
function checkDisplacementConflict(findingsA, findingsB) {
    const regexDisplaced = /\b(?:displaced|angulated)\b(?!\s+(?:non|un))/i;
    const regexUndisplaced = /\b(?:undisplaced|non-displaced|nondisplaced|anatomic(?:ally)?\s+aligned)\b/i;

    for (const fA of findingsA) {
        const isDisplacedA = regexDisplaced.test(fA) && !regexUndisplaced.test(fA);
        const isUndisplacedA = regexUndisplaced.test(fA);
        if (!isDisplacedA && !isUndisplacedA) continue;

        for (const fB of findingsB) {
            const isDisplacedB = regexDisplaced.test(fB) && !regexUndisplaced.test(fB);
            const isUndisplacedB = regexUndisplaced.test(fB);
            if (!isDisplacedB && !isUndisplacedB) continue;

            if ((isDisplacedA && isUndisplacedB) || (isUndisplacedA && isDisplacedB)) {
                return {
                    type: 'displacement_conflict',
                    evidence: [fA, fB],
                    detail: `Fracture displacement status conflict: ${isDisplacedA ? 'displaced' : 'undisplaced'} vs ${isDisplacedB ? 'displaced' : 'undisplaced'}`
                };
            }
        }
    }
    return null;
}

/**
 * Detect rapid disappearance of acute fracture within an unrealistically short time window (< minHealingDays).
 */
function checkRapidHealingConflict(studyA, studyB, findingsA, findingsB, minHealingDays = 7) {
    const dateA = parseDate(studyA.study_date);
    const dateB = parseDate(studyB.study_date);
    const daysDiff = daysBetween(dateA, dateB);

    // If dates are known and separated by >= minHealingDays, don't flag as impossible
    if (daysDiff !== null && daysDiff >= minHealingDays) {
        return null;
    }

    const regexFracturePresent = /\b(?:acute\s+fracture|fracture\s+present|cortical\s+disruption|radiographic\s+fracture)\b/i;
    const regexNoFracture = /\b(?:no\s+fracture|no\s+acute\s+abnormality|bone\s+is\s+intact|normal\s+radiograph)\b/i;

    for (const fA of findingsA) {
        if (!regexFracturePresent.test(fA)) continue;

        for (const fB of findingsB) {
            if (regexNoFracture.test(fB)) {
                const dayText = daysDiff !== null ? ` within ${Math.round(daysDiff)} days` : ' in consecutive studies';
                return {
                    type: 'rapid_healing_discordance',
                    evidence: [fA, fB],
                    detail: `Acute fracture reported then completely absent/normal${dayText} (< ${minHealingDays} days threshold)`
                };
            }
        }
    }
    return null;
}

/**
 * Main screening function: compares consecutive pairs of ordered studies.
 *
 * @param {Array<Object>} studies - Ordered array of study objects
 * @param {Object} [options]
 * @param {number} [options.minHealingDays=7] - Minimum days expected before acute fracture could be declared absent
 * @returns {Array<Object>} Array of screening discordance flags
 */
function detectDiscordance(studies, options = {}) {
    if (!Array.isArray(studies) || studies.length < 2) {
        return [];
    }

    const minHealingDays = (options && typeof options.minHealingDays === 'number')
        ? options.minHealingDays
        : getDiscordanceMinDays();
    const flags = [];

    for (let i = 0; i < studies.length - 1; i++) {
        const studyA = studies[i];
        const studyB = studies[i + 1];

        const findingsA = extractNonNumericFindings(studyA);
        const findingsB = extractNonNumericFindings(studyB);

        if (findingsA.length === 0 || findingsB.length === 0) continue;

        // Skip identical findings (no conflict)
        const identical = findingsA.length === findingsB.length &&
            findingsA.every((f, idx) => f.trim().toLowerCase() === findingsB[idx]?.trim().toLowerCase());
        if (identical) continue;

        // Check rules in order
        const laterality = checkLateralityFlip(findingsA, findingsB);
        if (laterality) {
            flags.push({
                pair: [i, i + 1],
                type: laterality.type,
                evidence: laterality.evidence,
                detail: laterality.detail,
                requires_clinician_review: true,
                note: 'Screening aid flagging potential documentation discordance. Not a definitive diagnosis.'
            });
        }

        const negation = checkNegationFlip(findingsA, findingsB);
        if (negation) {
            flags.push({
                pair: [i, i + 1],
                type: negation.type,
                evidence: negation.evidence,
                detail: negation.detail,
                requires_clinician_review: true,
                note: 'Screening aid flagging potential documentation discordance. Not a definitive diagnosis.'
            });
        }

        const displacement = checkDisplacementConflict(findingsA, findingsB);
        if (displacement) {
            flags.push({
                pair: [i, i + 1],
                type: displacement.type,
                evidence: displacement.evidence,
                detail: displacement.detail,
                requires_clinician_review: true,
                note: 'Screening aid flagging potential documentation discordance. Not a definitive diagnosis.'
            });
        }

        const rapidHealing = checkRapidHealingConflict(studyA, studyB, findingsA, findingsB, minHealingDays);
        if (rapidHealing) {
            flags.push({
                pair: [i, i + 1],
                type: rapidHealing.type,
                evidence: rapidHealing.evidence,
                detail: rapidHealing.detail,
                requires_clinician_review: true,
                note: 'Screening aid flagging potential documentation discordance. Not a definitive diagnosis.'
            });
        }
    }

    return flags;
}

module.exports = {
    detectDiscordance,
    extractNonNumericFindings,
    checkLateralityFlip,
    checkNegationFlip,
    checkDisplacementConflict,
    checkRapidHealingConflict,
    DISCORDANCE_MIN_DAYS,
    getDiscordanceMinDays
};
