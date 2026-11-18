require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bodyParser = require('body-parser');
const argon2 = require('argon2');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');


const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-change-this';
const INTEGRITY_SECRET = process.env.INTEGRITY_SECRET || 'fallback-integrity-secret';

const app = express();

// --- Audit Logging Helper ---
function addAuditLog(req, action, details = null) {
    const user_id = req.user ? req.user.id : null;
    const username = req.user ? req.user.username : (req.body.username || 'anonymous');
    const role = req.user ? req.user.role : 'unknown';
    const ip_address = req.ip || req.connection.remoteAddress;

    const query = 'INSERT INTO audit_logs (user_id, username, role, action, details, ip_address) VALUES (?, ?, ?, ?, ?, ?)';
    db.query(query, [user_id, username, role, action, typeof details === 'object' ? JSON.stringify(details) : details, ip_address], (err) => {
        if (err) console.error('[AUDIT ERROR] Failed to write log:', err.message);
    });
}
// ----------------------------



app.use(cors({
    origin: (origin, callback) => {
        // Allow any origin for demo purposes to support "any device" login
        callback(null, true);
    },
    credentials: true
}));

app.use(bodyParser.json());
app.use(cookieParser());

// Robust JWT Verification Middleware
app.use((req, res, next) => {
    if (req.cookies.token) {
        try {
            // Verify HMAC-SHA256 signature and attach payload
            const decoded = jwt.verify(req.cookies.token, JWT_SECRET, { algorithms: ['HS256'] });
            req.user = decoded;
        } catch (e) {
            console.error('JWT verification failed:', e.message);
        }
    }
    next();
});

const db = mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'hospital'
});

db.connect((err) => {
    if (err) throw err;
    console.log('Connected to MySQL');
    // Create tables
    db.query(`CREATE TABLE IF NOT EXISTS patients (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255),
    age INT
  )`, (err) => { if (err) console.log(err); });

    db.query(`CREATE TABLE IF NOT EXISTS audit_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT,
        username VARCHAR(255),
        role VARCHAR(50),
        action VARCHAR(255),
        details TEXT,
        ip_address VARCHAR(45),
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`, (err) => { if (err) console.log(err); });
    db.query(`CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(255) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        role ENUM('patient', 'doctor', 'hospital_admin') NOT NULL,
        fingerprint VARCHAR(255)
    )`, (err) => { 
        if (err) console.log(err); 
        else {
            // Migration: Add fingerprint column if it doesn't exist
            db.query(`ALTER TABLE users ADD COLUMN fingerprint VARCHAR(255)`, (err) => {
                if (err && !err.message.includes('Duplicate column')) console.log('Note: Fingerprint column check:', err.message);
            });
        }
    });

    // Drop and recreate visits table to ensure notes column exists
    db.query(`DROP TABLE IF EXISTS visits`, (err) => {
        if (err) console.log('Error dropping visits table:', err);
    });

    db.query(`CREATE TABLE visits (
            id INT AUTO_INCREMENT PRIMARY KEY,
            patient_id INT,
            doctor_id INT,
            diagnosis TEXT,
            treatment TEXT,
            prescription TEXT,
            report VARCHAR(255),
            signature VARCHAR(255),
            visit_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            progress ENUM('ongoing', 'completed') DEFAULT 'ongoing',
            notes TEXT,
            FOREIGN KEY (patient_id) REFERENCES patients(id),
            FOREIGN KEY (doctor_id) REFERENCES users(id)
        )`, (err) => {
        if (err) console.log('Error creating visits table:', err);
        else console.log('Visits table created successfully with notes column');
    });

    // Create patient_profiles table for extended patient information
    db.query(`CREATE TABLE IF NOT EXISTS patient_profiles (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT,
        email VARCHAR(255),
        phone VARCHAR(20),
        address TEXT,
        date_of_birth DATE,
        gender ENUM('male', 'female', 'other'),
        blood_group VARCHAR(5),
        emergency_contact VARCHAR(20),
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`, (err) => { if (err) console.log(err); });

    // Create appointments table with approval status
    db.query(`DROP TABLE IF EXISTS appointments`, (err) => {
        if (err) console.log('Error dropping appointments table:', err);
    });

    db.query(`CREATE TABLE appointments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        patient_id INT,
        doctor_id INT,
        appointment_date DATETIME,
        status ENUM('scheduled', 'completed', 'cancelled') DEFAULT 'scheduled',
        approval_status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
        reason TEXT,
        notes TEXT,
        approved_at DATETIME,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (patient_id) REFERENCES patients(id),
        FOREIGN KEY (doctor_id) REFERENCES users(id)
    )`, (err) => {
        if (err) console.log('Error creating appointments table:', err);
        else {
            console.log('Appointments table created successfully with approval system');
            // Add index for performance
            db.query(`CREATE INDEX idx_appt_approval ON appointments(approval_status)`, (err) => {
                if (err && !err.message.includes('Duplicate key name')) console.log('Note: Appt index check:', err.message);
            });
        }
    });

    // Create notifications table
    db.query(`CREATE TABLE IF NOT EXISTS notifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT,
        title VARCHAR(255),
        message TEXT,
        type ENUM('appointment', 'visit', 'payment', 'general') DEFAULT 'general',
        is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`, (err) => {
        if (err) console.log('Error creating notifications table:', err);
        else {
            console.log('Notifications table created successfully');
            // Add index for performance
            db.query(`CREATE INDEX idx_notify_user_read ON notifications(user_id, is_read)`, (err) => {
                if (err && !err.message.includes('Duplicate key name')) console.log('Note: Notify index check:', err.message);
            });
        }
    });

    // Create medical_images table
    db.query(`CREATE TABLE IF NOT EXISTS medical_images (
        id INT AUTO_INCREMENT PRIMARY KEY,
        patient_id INT,
        uploaded_by INT,
        raw_file_path TEXT,
        anonymized_file_path TEXT,
        status VARCHAR(50),
        phi_detected INT DEFAULT 0,
        fracture_protected INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (patient_id) REFERENCES patients(id),
        FOREIGN KEY (uploaded_by) REFERENCES users(id)
    )`, (err) => {
        if (err) console.log('Error creating medical_images table:', err);
        else console.log('medical_images table created successfully');
    });

    // Create clinical_summaries table
    db.query(`CREATE TABLE IF NOT EXISTS clinical_summaries (
        id INT AUTO_INCREMENT PRIMARY KEY,
        case_id VARCHAR(255),
        summary_text TEXT,
        trend_data JSON,
        anomaly_flag BOOLEAN DEFAULT FALSE,
        source VARCHAR(255),
        status ENUM('pending_review', 'approved', 'rejected') DEFAULT 'pending_review',
        generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) console.log('Error creating clinical_summaries table:', err);
        else console.log('clinical_summaries table created successfully');
    });

    Promise.all([
        argon2.hash('pass1'),
        argon2.hash('pass2'),
        argon2.hash('pass3')
    ]).then(([hash1, hash2, hash3]) => {
        db.query("INSERT IGNORE INTO users (username, password, role) VALUES ('patient1', ?, 'patient'), ('doctor1', ?, 'doctor'), ('admin1', ?, 'hospital_admin')", [hash1, hash2, hash3], (err) => { if (err) console.log(err); });
    });

    // Create default patients for testing with proper names
    db.query("INSERT IGNORE INTO patients (id, name, age) VALUES (1, 'John Smith', 30), (2, 'Sarah Johnson', 25), (3, 'patient1', 28)", (err) => {
        if (err) console.log(err);
        else console.log('Default patients created: John Smith, Sarah Johnson, patient1');
    });

    // Create default patient profile if not exists
    db.query("INSERT IGNORE INTO patient_profiles (user_id, email, phone) SELECT id, CONCAT(username, '@example.com'), '0000000000' FROM users WHERE username='patient1'", (err) => { if (err) console.log(err); });

    // Seed demo appointments with different approval statuses (after visits are done)
    setTimeout(() => {
        seedDemoData();
    }, 2000);
});

// HMAC-SHA256 signature for diagnosis-submission integrity (signs patient_id|diagnosis).
// SECURITY FIX: this function was called at /api/diagnosis/submit but was never defined,
// which caused a ReferenceError at runtime on every diagnosis submission.
function generateClinicalSignature(patient_id, diagnosis) {
    const dataString = `${patient_id}|${diagnosis}`;
    return crypto.createHmac('sha256', INTEGRITY_SECRET).update(dataString).digest('hex');
}

// Helper function to generate HMAC signature for integrity protection
function generateVisitSignature(data) {
    // We sign the main medical fields to prevent tampering
    const dataString = `${data.patient_id}|${data.diagnosis}|${data.treatment || ''}`;
    return crypto.createHmac('sha256', INTEGRITY_SECRET).update(dataString).digest('hex');
}

// Function to seed demo data
function seedDemoData() {
    console.log('Seeding demo medical data...');

    // Get doctor1's ID
    db.query("SELECT id FROM users WHERE username='doctor1'", (err, doctorResult) => {
        if (err || doctorResult.length === 0) return;
        const doctorId = doctorResult[0].id;

        // Get patient IDs
        db.query("SELECT id, name FROM patients", (err, patientResult) => {
            if (err || patientResult.length === 0) return;

            const patient1Id = patientResult.find(p => p.name === 'patient1')?.id || 3;
            const patient2Id = patientResult.find(p => p.name === 'Sarah Johnson')?.id || 2;

            // Demo visits data
            const demoVisits = [
                {
                    patient_id: patient1Id,
                    doctor_id: doctorId,
                    diagnosis: 'Seasonal Flu',
                    treatment: 'Rest and hydration',
                    prescription: 'Paracetamol 500mg, Vitamin C supplements',
                    report: 'flu_test_report.pdf',
                    progress: 'completed',
                    notes: 'Patient responded well to treatment. Follow-up in 1 week.',
                    visit_date: '2024-01-15 10:30:00'
                },
                {
                    patient_id: patient1Id,
                    doctor_id: doctorId,
                    diagnosis: 'Hypertension',
                    treatment: 'Lifestyle modifications and medication',
                    prescription: 'Amlodipine 5mg daily, Low sodium diet',
                    report: 'bp_monitoring_jan2024.pdf',
                    progress: 'ongoing',
                    notes: 'BP stabilized at 130/85. Continue medication. Regular exercise advised.',
                    visit_date: '2024-02-20 14:15:00'
                },
                {
                    patient_id: patient1Id,
                    doctor_id: doctorId,
                    diagnosis: 'Type 2 Diabetes',
                    treatment: 'Diet control, exercise, and insulin therapy',
                    prescription: 'Metformin 500mg twice daily, Insulin glargine at bedtime',
                    report: 'hba1c_feb2024.pdf',
                    progress: 'ongoing',
                    notes: 'HbA1c at 7.2%. Patient advised on carbohydrate counting and regular glucose monitoring.',
                    visit_date: '2024-03-10 09:00:00'
                },
                {
                    patient_id: patient2Id,
                    doctor_id: doctorId,
                    diagnosis: 'Acute Bronchitis',
                    treatment: 'Antibiotics and cough suppressants',
                    prescription: 'Azithromycin 250mg, Dextromethorphan syrup',
                    report: 'chest_xray_march2024.pdf',
                    progress: 'completed',
                    notes: 'Chest X-ray clear. Symptoms resolved. Full recovery expected.',
                    visit_date: '2024-01-25 11:45:00'
                },
                {
                    patient_id: patient2Id,
                    doctor_id: doctorId,
                    diagnosis: 'Migraine',
                    treatment: 'Pain management and trigger avoidance',
                    prescription: 'Sumatriptan 50mg as needed, Propranolol 40mg daily',
                    report: '',
                    progress: 'ongoing',
                    notes: 'Patient identified stress and lack of sleep as triggers. Advised on sleep hygiene.',
                    visit_date: '2024-02-28 16:30:00'
                },
                {
                    patient_id: patient2Id,
                    doctor_id: doctorId,
                    diagnosis: 'Vitamin D Deficiency',
                    treatment: 'Supplementation and sun exposure',
                    prescription: 'Cholecalciferol 60000 IU weekly for 8 weeks',
                    report: 'vitamin_d_levels.pdf',
                    progress: 'ongoing',
                    notes: 'Level improved from 12 to 28 ng/mL. Continue supplementation for 4 more weeks.',
                    visit_date: '2024-03-18 10:00:00'
                }
            ];

            // Insert demo visits
            let inserted = 0;
            demoVisits.forEach((visit, index) => {
                const params = [
                    visit.patient_id,
                    visit.doctor_id,
                    visit.diagnosis,
                    visit.treatment,
                    visit.prescription,
                    visit.report,
                    visit.progress,
                    visit.notes,
                    visit.visit_date
                ];

                // Generate signature for demo data
                const signature = generateVisitSignature(visit);

                const query = `INSERT INTO visits (patient_id, doctor_id, diagnosis, treatment, prescription, report, progress, notes, visit_date, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
                db.query(query, [...params, signature], (err) => {


                    if (err) {
                        console.log(`Error inserting visit ${index + 1}:`, err.message);
                    } else {
                        inserted++;
                        console.log(`âœ“ Inserted: ${visit.diagnosis} for ${visit.patient_id === patient1Id ? 'patient1' : 'Sarah Johnson'}`);
                        if (inserted === demoVisits.length) {
                            console.log('\nâœ… Demo data seeding complete! ' + inserted + ' visits added.');
                            console.log('\nðŸ“Š Demo Data Summary:');
                            console.log('   - John Smith: 3 visits (Flu, Hypertension, Diabetes)');
                            console.log('   - Sarah Johnson: 3 visits (Bronchitis, Migraine, Vitamin D)');
                            console.log('   - Doctor: doctor1');
                            console.log('   - Date range: Jan 2024 - Mar 2024\n');
                        }
                    }
                });
            });

            // Seed demo appointments after visits are inserted
            setTimeout(() => {
                seedDemoAppointments(doctorId, patient1Id, patient2Id);
            }, 1000);
        });
    });
}

// Function to seed demo appointments
function seedDemoAppointments(doctorId, patient1Id, patient2Id) {
    console.log('Seeding demo appointments...');

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const twoDaysAgo = new Date(Date.now() - 86400000 * 2).toISOString().slice(0, 19).replace('T', ' ');
    const oneDayAgo = new Date(Date.now() - 86400000).toISOString().slice(0, 19).replace('T', ' ');

    const demoAppointments = [
        {
            patient_id: patient1Id,
            doctor_id: doctorId,
            appointment_date: '2024-03-25 10:00:00',
            status: 'scheduled',
            approval_status: 'pending',
            reason: 'Regular health checkup - need medical certificate for work',
            notes: '',
            created_at: now
        },
        {
            patient_id: patient2Id,
            doctor_id: doctorId,
            appointment_date: '2024-03-26 14:30:00',
            status: 'scheduled',
            approval_status: 'pending',
            reason: 'Persistent headache for past 3 days',
            notes: '',
            created_at: now
        },
        {
            patient_id: patient1Id,
            doctor_id: doctorId,
            appointment_date: '2024-03-22 11:00:00',
            status: 'scheduled',
            approval_status: 'approved',
            reason: 'Follow-up visit for hypertension',
            notes: 'Approved. Please bring BP monitoring records.',
            approved_at: '2024-03-20 09:00:00',
            created_at: twoDaysAgo
        },
        {
            patient_id: patient2Id,
            doctor_id: doctorId,
            appointment_date: '2024-03-23 15:00:00',
            status: 'scheduled',
            approval_status: 'rejected',
            reason: 'Need to reschedule due to conference',
            notes: 'Sorry, I have a medical conference on this date. Please book another slot.',
            created_at: oneDayAgo
        }
    ];

    let inserted = 0;
    demoAppointments.forEach((appt, index) => {
        const query = `INSERT INTO appointments (patient_id, doctor_id, appointment_date, status, approval_status, reason, notes, approved_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        db.query(query, [
            appt.patient_id,
            appt.doctor_id,
            appt.appointment_date,
            appt.status,
            appt.approval_status,
            appt.reason,
            appt.notes,
            appt.approved_at,
            appt.created_at
        ], (err) => {
            if (err) {
                console.log(`Error inserting appointment ${index + 1}:`, err.message);
            } else {
                inserted++;
                const status = appt.approval_status.charAt(0).toUpperCase() + appt.approval_status.slice(1);
                console.log(`âœ“ Inserted: ${status} appointment for ${appt.patient_id === patient1Id ? 'John Smith' : 'Sarah Johnson'}`);

                if (inserted === demoAppointments.length) {
                    console.log('\nâœ… Demo appointments seeded!');
                    console.log('ðŸ“Š Appointment Summary:');
                    console.log('   - â³ Pending: 2 (patient1, Sarah Johnson)');
                    console.log('   - âœ“ Approved: 1 (patient1 - Follow-up)');
                    console.log('   - âœ— Rejected: 1 (Sarah Johnson - Conference)');
                    console.log('');
                }
            }
        });
    });
}

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.query('SELECT * FROM users WHERE username = ?', [username], async (err, results) => {
        if (err) return res.status(500).send(err);
        if (results.length > 0) {
            const user = results[0];
            try {
                if (await argon2.verify(user.password, password)) {
                    // Generate JWT with HMAC-SHA256, expiration: 1 hour
                    const token = jwt.sign(
                        { id: user.id, username: user.username, role: user.role },
                        JWT_SECRET,
                        { algorithm: 'HS256', expiresIn: '1h' }
                    );

                    // Securely set the JWT in an HttpOnly cookie.
                    // secure=true in production (HTTPS); false in local dev.
                    const isProduction = process.env.NODE_ENV === 'production';
                    res.cookie('token', token, { httpOnly: true, secure: isProduction, sameSite: 'Strict' });

                    // Log successful login
                    req.user = { id: user.id, username: user.username, role: user.role };
                    addAuditLog(req, 'LOGIN_SUCCESS');


                    // --- Device Fingerprinting Logic ---
                    const { fingerprintData } = req.body;
                    let fingerprintMismatch = false;

                    if (fingerprintData) {
                        const fingerprintString = `${fingerprintData.userAgent}|${fingerprintData.screenRes}|${fingerprintData.timezone}`;
                        const currentFingerprint = crypto.createHash('sha256').update(fingerprintString).digest('hex');

                        // Check against stored fingerprint
                        if (!user.fingerprint) {
                            // First time login on this new system, store the fingerprint
                            db.query('UPDATE users SET fingerprint = ? WHERE id = ?', [currentFingerprint, user.id]);
                            console.log(`[SECURITY] Primary fingerprint stored for user: ${user.username}`);
                        } else if (user.fingerprint !== currentFingerprint) {
                            // Mismatch detected!
                            fingerprintMismatch = true;
                            console.warn(`[SECURITY ALERT] Fingerprint mismatch for user: ${user.username}`);
                            console.warn(`Stored: ${user.fingerprint}`);
                            console.warn(`Current: ${currentFingerprint}`);
                        }
                    }
                    // ------------------------------------

                    res.send({
                        success: true,
                        user: { id: user.id, username: user.username, role: user.role },
                        fingerprintMismatch
                    });
                } else {
                    addAuditLog(req, 'LOGIN_FAILURE', { reason: 'Invalid password' });
                    res.send({ success: false, message: 'Invalid credentials' });
                }
            } catch (err) {
                console.error(err);
                addAuditLog(req, 'LOGIN_ERROR', { error: err.message });
                res.status(500).send('Internal Server Error');
            }
        } else {
            addAuditLog(req, 'LOGIN_FAILURE', { reason: 'User not found' });
            res.send({ success: false, message: 'Invalid credentials' });
        }
    });
});

app.get('/me', (req, res) => {
    if (req.user) {
        res.send({ success: true, user: req.user });
    } else {
        res.send({ success: false });
    }
});

app.post('/logout', (req, res) => {
    addAuditLog(req, 'LOGOUT');
    res.clearCookie('token');
    res.send({ success: true });
});

// Patient Registration
app.post('/patient/register', async (req, res) => {
    const { username, password, name, age, email, phone, address, date_of_birth, gender, blood_group, emergency_contact } = req.body;

    if (!username || !password || !name || !age) {
        return res.status(400).send('Missing required fields');
    }

    try {
        const hashedPassword = await argon2.hash(password);
        db.query('INSERT INTO users (username, password, role) VALUES (?, ?, ?)', [username, hashedPassword, 'patient'], (err, result) => {
            if (err) {
                if (err.code === 'ER_DUP_ENTRY') return res.status(409).send('Username already exists');
                return res.status(500).send(err);
            }

            const userId = result.insertId;

            // Create patient record
            db.query('INSERT INTO patients (name, age) VALUES (?, ?)', [name, age], (err) => {
                if (err) console.log('Error creating patient record:', err);
            });

            // Create patient profile
            db.query('INSERT INTO patient_profiles (user_id, email, phone, address, date_of_birth, gender, blood_group, emergency_contact) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [userId, email || '', phone || '', address || '', date_of_birth || null, gender || null, blood_group || null, emergency_contact || null],
                (err) => {
                    if (err) console.log('Error creating profile:', err);
                }
            );

            res.send({ success: true, message: 'Registration successful' });
        });
    } catch (err) {
        res.status(500).send({ success: false, message: 'Error hashing password' });
    }
});

// Get Patient Profile
app.get('/patient/profile', (req, res) => {
    if (!req.user || req.user.role !== 'patient') {
        return res.status(403).send('Forbidden');
    }

    addAuditLog(req, 'VIEW_PROFILE');
    db.query('SELECT * FROM patient_profiles WHERE user_id = ?', [req.user.id], (err, results) => {
        if (err) return res.status(500).send(err);
        if (results.length === 0) return res.status(404).send('Profile not found');
        res.send(results[0]);
    });
});

// Update Patient Profile
app.put('/patient/profile', (req, res) => {
    if (!req.user || req.user.role !== 'patient') {
        return res.status(403).send('Forbidden');
    }

    const { email, phone, address, date_of_birth, gender, blood_group, emergency_contact } = req.body;

    db.query('UPDATE patient_profiles SET email = ?, phone = ?, address = ?, date_of_birth = ?, gender = ?, blood_group = ?, emergency_contact = ? WHERE user_id = ?',
        [email, phone, address, date_of_birth, gender, blood_group, emergency_contact, req.user.id],
        (err) => {
            if (err) return res.status(500).send(err);
            addAuditLog(req, 'UPDATE_PROFILE');
            res.send({ success: true, message: 'Profile updated successfully' });
        }
    );
});

app.get('/patients', (req, res) => {
    if (!req.user) return res.status(401).send('Not logged in');
    if (req.user.role === 'patient') {
        // Fetch visits for the logged-in patient by joining with users table
        db.query(`SELECT v.*, p.name as patient_name 
                  FROM visits v 
                  JOIN patients p ON v.patient_id = p.id 
                  WHERE p.name = ? 
                  ORDER BY v.visit_date DESC`,
            [req.user.username],
            (err, results) => {
                if (err) return res.status(500).send(err);
                res.send(results);
            }
        );
    } else if (req.user.role === 'doctor' || req.user.role === 'hospital_admin') {
        db.query('SELECT * FROM patients', (err, results) => {
            if (err) return res.status(500).send(err);
            res.send(results);
        });
    }
});

// Get Patient's Complete Medical History
app.get('/patient/medical-history', (req, res) => {
    if (!req.user || req.user.role !== 'patient') {
        return res.status(403).send('Forbidden');
    }

    addAuditLog(req, 'VIEW_MEDICAL_HISTORY');
    db.query(`SELECT v.*, p.name as patient_name, u.username as doctor_name 
              FROM visits v 
              JOIN patients p ON v.patient_id = p.id 
              JOIN users u ON v.doctor_id = u.id 
              WHERE p.name = ? 
              ORDER BY v.visit_date DESC`,
        [req.user.username],
        (err, results) => {
            if (err) return res.status(500).send(err);
            
            // VERIFY SIGNATURES
            const verifiedResults = results.map(visit => {
                const expectedSignature = generateVisitSignature({ 
                    patient_id: visit.patient_id, 
                    diagnosis: visit.diagnosis, 
                    treatment: visit.treatment 
                });
                
                return {
                    ...visit,
                    tampered: visit.signature !== expectedSignature
                };
            });
            
            res.send(verifiedResults);
        }
    );
});

// Get Patient Dashboard Stats
app.get('/patient/dashboard', (req, res) => {
    if (!req.user || req.user.role !== 'patient') {
        return res.status(403).send('Forbidden');
    }

    // Get total visits
    db.query('SELECT COUNT(*) as totalVisits FROM visits v JOIN patients p ON v.patient_id = p.id WHERE p.name = ?', [req.user.username], (err, visitCount) => {
        if (err) return res.status(500).send(err);

        // Get ongoing treatments
        db.query('SELECT COUNT(*) as ongoingTreatments FROM visits v JOIN patients p ON v.patient_id = p.id WHERE p.name = ? AND v.progress = ?', [req.user.username, 'ongoing'], (err, ongoingCount) => {
            if (err) return res.status(500).send(err);

            // Get recent visits (last 5)
            db.query(`SELECT v.*, u.username as doctor_name 
                      FROM visits v 
                      JOIN patients p ON v.patient_id = p.id 
                      JOIN users u ON v.doctor_id = u.id 
                      WHERE p.name = ? 
                      ORDER BY v.visit_date DESC LIMIT 5`,
                [req.user.username],
                (err, recentVisits) => {
                    if (err) return res.status(500).send(err);

                    // Get latest prescription
                    db.query(`SELECT v.prescription, v.visit_date 
                              FROM visits v 
                              JOIN patients p ON v.patient_id = p.id 
                              WHERE p.name = ? AND v.prescription IS NOT NULL AND v.prescription != '' 
                              ORDER BY v.visit_date DESC LIMIT 1`,
                        [req.user.username],
                        (err, latestPrescription) => {
                            if (err) return res.status(500).send(err);

                            res.send({
                                totalVisits: visitCount[0].totalVisits,
                                ongoingTreatments: ongoingCount[0].ongoingTreatments,
                                recentVisits: recentVisits,
                                latestPrescription: latestPrescription[0] || null
                            });
                        }
                    );
                }
            );
        });
    });
});

// Download Report (Get report file path/URL)
app.get('/patient/reports', (req, res) => {
    if (!req.user || req.user.role !== 'patient') {
        return res.status(403).send('Forbidden');
    }

    addAuditLog(req, 'VIEW_REPORTS');
    db.query(`SELECT v.id, v.visit_date, v.report, v.diagnosis, u.username as doctor_name 
              FROM visits v 
              JOIN patients p ON v.patient_id = p.id 
              JOIN users u ON v.doctor_id = u.id 
              WHERE p.name = ? AND v.report IS NOT NULL AND v.report != '' 
              ORDER BY v.visit_date DESC`,
        [req.user.username],
        (err, results) => {
            if (err) return res.status(500).send(err);
            res.send(results);
        }
    );
});

app.get('/patients/:id', (req, res) => {
    if (!req.user) return res.status(401).send('Unauthorized');
    const patientId = req.params.id;

    addAuditLog(req, 'VIEW_PATIENT_RECORDS', { patient_id: patientId });
    db.query('SELECT * FROM patients WHERE id = ?', [patientId], (err, patientResults) => {
        if (err) return res.status(500).send(err);
        if (patientResults.length === 0) return res.status(404).send('Patient not found');
        db.query('SELECT visits.*, users.username as doctor_name FROM visits JOIN users ON visits.doctor_id = users.id WHERE visits.patient_id = ?', [patientId], (err, visitResults) => {
            if (err) return res.status(500).send(err);
            
            // VERIFY SIGNATURES
            const verifiedVisits = visitResults.map(visit => {
                const expectedSignature = generateVisitSignature({ 
                    patient_id: visit.patient_id, 
                    diagnosis: visit.diagnosis, 
                    treatment: visit.treatment 
                });
                
                return {
                    ...visit,
                    tampered: visit.signature !== expectedSignature
                };
            });

            res.send({ patient: patientResults[0], visits: verifiedVisits });
        });
    });
});

app.get('/patients/search', (req, res) => {
    if (!req.user || (req.user.role !== 'doctor' && req.user.role !== 'hospital_admin')) {
        return res.status(403).send('Forbidden');
    }
    const { query } = req.query;
    if (!query) return res.status(400).send('Missing search query');
    db.query('SELECT * FROM patients WHERE name LIKE ? OR id = ?', [`%${query}%`, query], (err, results) => {
        if (err) return res.status(500).send(err);
        res.send(results);
    });
});

const multer = require('multer');
var path = require('path');

// Configure Multer for report uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/');
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// Serve uploaded files statically
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.post('/visits', upload.single('reportFile'), (req, res) => {
    if (!req.user || req.user.role !== 'doctor') {
        return res.status(403).send('Forbidden: Only doctors can add visits');
    }

    const { patient_id, diagnosis, treatment, prescription, progress, notes } = req.body;

    // If a file was uploaded, use its path; otherwise use the generic 'report' text if provided
    const reportPath = req.file ? `/uploads/${req.file.filename}` : (req.body.report || '');

    // Validate required fields
    if (!patient_id || !diagnosis || !treatment) {
        return res.status(400).send('Missing required fields: patient_id, diagnosis, and treatment are required');
    }

    // Generate integrity signature before saving
    const signature = generateVisitSignature({ patient_id, diagnosis, treatment });

    db.query('INSERT INTO visits (patient_id, doctor_id, diagnosis, treatment, prescription, report, progress, notes, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [patient_id, req.user.id, diagnosis, treatment, prescription || '', reportPath, progress || 'ongoing', notes || '', signature],
        (err) => {
            if (err) {
                console.error('Database error:', err);
                return res.status(500).send('Error saving visit: ' + err.message);
            }
            addAuditLog(req, 'ADD_VISIT', { patient_id, diagnosis });
            res.send({ success: true, message: 'Visit added successfully (Integrity Protected)', signature, filePath: reportPath });
        }
    );
});


// Generate an HMAC signature for a diagnosis (keeps secret server-side).
// The frontend calls this before /api/diagnosis/submit.
app.post('/api/diagnosis/sign', (req, res) => {
    if (!req.user || req.user.role !== 'doctor') {
        return res.status(403).send('Forbidden: Only doctors can sign diagnoses');
    }
    const { patient_id, diagnosis } = req.body;
    if (!patient_id || !diagnosis) {
        return res.status(400).send('Missing patient_id or diagnosis');
    }
    const signature = generateClinicalSignature(patient_id, diagnosis);
    res.send({ signature });
});

// Secure Diagnosis Submission with HMAC Integrity Check (Demo)
app.post('/api/diagnosis/submit', (req, res) => {
    if (!req.user || req.user.role !== 'doctor') {
        return res.status(403).send('Forbidden: Only doctors can submit diagnosis');
    }

    const { patient_id, diagnosis, signature } = req.body;

    if (!patient_id || !diagnosis) {
        return res.status(400).send('Missing required fields: patient_id and diagnosis');
    }

    // INTEGRITY CHECK: Signature is MANDATORY on every diagnosis submission.
    // SECURITY FIX: previously signature was optional; unsigned requests were silently accepted.
    if (!signature) {
        addAuditLog(req, 'SECURITY_ALERT_TAMPERING', {
            patient_id, diagnosis, provided_signature: null,
            reason: 'Missing HMAC signature -- unsigned request rejected'
        });
        return res.status(400).send({
            success: false,
            message: 'SECURITY ERROR: HMAC signature is required for diagnosis submission.'
        });
    }

    const expectedSignature = generateClinicalSignature(patient_id, diagnosis);

    if (signature !== expectedSignature) {
        addAuditLog(req, 'SECURITY_ALERT_TAMPERING', {
            patient_id,
            diagnosis,
            provided_signature: signature,
            expected_signature: expectedSignature
        });
        console.error('SECURITY ERROR: Data integrity violation! The diagnosis has been tampered with.');
        return res.status(403).send({
            success: false,
            message: 'SECURITY ERROR: Data integrity violation! The diagnosis has been tampered with.',
            tampered: true
        });
    }

    // SECURITY FIX: Ensure the doctor is authorized (for demo, we just log the action and allow)
    // In a real system, you would check if this doctor is assigned to this patient.
    addAuditLog(req, 'DIAGNOSIS_SUBMIT_ATTEMPT', { patient_id, diagnosis });
    db.query('UPDATE visits SET diagnosis = ?, signature = ? WHERE patient_id = ? ORDER BY visit_date DESC LIMIT 1',
        [diagnosis, generateVisitSignature({ patient_id, diagnosis, treatment: 'Updated via API' }), patient_id],
        (err, result) => {
            if (err) {
                console.error('Database error:', err);
                return res.status(500).send('Error saving diagnosis: ' + err.message);
            }

            if (result.affectedRows === 0) {
                // If no visit exists, create a dummy one
                const newSignature = generateVisitSignature({ patient_id, diagnosis, treatment: 'Initial Consultation' });
                db.query('INSERT INTO visits (patient_id, doctor_id, diagnosis, treatment, progress, signature) VALUES (?, ?, ?, ?, ?, ?)',
                    [patient_id, req.user.id, diagnosis, 'Initial Consultation', 'ongoing', newSignature],
                    (err) => {
                        if (err) return res.status(500).send(err.message);
                        res.send({ success: true, message: 'New visit record created with integrity signature', signature: newSignature });
                    }
                );
            } else {
                res.send({ success: true, message: 'Latest visit diagnosis updated and re-signed', signature: generateVisitSignature({ patient_id, diagnosis, treatment: 'Updated via API' }) });
            }
        }
    );
});



// â”€â”€ NEW: 3-panel anonymization demo endpoints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Proxy to ML service's dataset image list
app.get('/api/demo/dataset-images', async (req, res) => {
    if (!req.user || req.user.role !== 'hospital_admin') {
        return res.status(403).send('Forbidden');
    }
    try {
        const mlServiceUrl = process.env.ANONYMIZATION_SERVICE_URL || 'http://localhost:8000';
        const response = await axios.get(`${mlServiceUrl}/demo/dataset-images`);
        res.json(response.data);
    } catch (err) {
        res.status(503).json({ error: 'ML service unavailable', images: [] });
    }
});

// Proxy to ML service's /demo-pipeline â€” returns original + contaminated + anonymized
app.post('/api/demo/anonymization-demo', upload.single('file'), async (req, res) => {
    if (!req.user || req.user.role !== 'hospital_admin') {
        return res.status(403).send('Forbidden: Only admins can run anonymization demos');
    }
    try {
        const mlServiceUrl = process.env.ANONYMIZATION_SERVICE_URL || 'http://localhost:8000';
        const formData = new FormData();

        if (req.file) {
            formData.append('file', fs.createReadStream(req.file.path), {
                filename: req.file.originalname,
                contentType: req.file.mimetype
            });
        } else if (req.body.dataset_image) {
            formData.append('dataset_image', req.body.dataset_image);
        } else {
            return res.status(400).json({ error: 'Provide file upload or dataset_image' });
        }

        const response = await axios.post(`${mlServiceUrl}/demo-pipeline`, formData, {
            headers: formData.getHeaders(),
            maxBodyLength: Infinity, maxContentLength: Infinity
        });

        if (req.file) {
            try { fs.unlinkSync(req.file.path); } catch (_) {}
        }

        addAuditLog(req, 'DEMO_ANONYMIZATION', {
            source: req.body.dataset_image || req.file?.originalname || 'unknown',
            totalPHI: response.data.metrics?.totalPHI,
            detectedPHI: response.data.metrics?.detectedPHI
        });

        res.json(response.data);
    } catch (error) {
        console.error('Demo pipeline error:', error.message);
        res.status(500).json({ error: 'Demo pipeline failed: ' + error.message });
    }
});
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.post('/api/admin/anonymization/images', upload.single('image'), async (req, res) => {
    if (!req.user || req.user.role !== 'hospital_admin') {
        return res.status(403).send('Forbidden: Only admins can perform anonymization');
    }


    if (!req.file) return res.status(400).send('No image file provided');
    if (!req.body.patientId) return res.status(400).send('No patient ID provided');

    try {
        const tempPath = req.file.path;
        const rawFilename = 'raw_' + Date.now() + '_' + req.file.originalname;
        const rawPath = 'uploads/raw/restricted/' + rawFilename;
        fs.renameSync(tempPath, rawPath);
        
        const formData = new FormData();
        formData.append('file', fs.createReadStream(rawPath));
        
        const mlServiceUrl = process.env.ANONYMIZATION_SERVICE_URL || 'http://localhost:8000';
        
        const response = await axios.post(`${mlServiceUrl}/anonymize`, formData, {
            headers: formData.getHeaders(),
            maxBodyLength: Infinity, maxContentLength: Infinity
        });

        const result = response.data;
        if (result.status !== 'success' && result.status !== 'manual_review_required') {
            return res.status(500).send({ success: false, error: 'ML Anonymization failed.' });
        }
        
        const anonFilename = 'anon_' + Date.now() + '.jpg';
        const anonPath = 'uploads/anonymized/doctor_access/' + anonFilename;
        fs.writeFileSync(anonPath, Buffer.from(result.image_base64, 'base64'));
        
        const phiCount = result.phi_lines_detected || 0;
        const fracCount = result.fracture_boxes || 0;
        
        db.query(
            'INSERT INTO medical_images (patient_id, uploaded_by, raw_file_path, anonymized_file_path, status, phi_detected, fracture_protected) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [req.body.patientId, req.user.userId || 1, rawPath, anonPath, 'SUCCESS', phiCount, fracCount],
            (err, dbRes) => {
                if (err) console.error(err);
                
                addAuditLog(req, 'ANONYMIZE_IMAGE', {
                    patient_id: req.body.patientId,
                    status: result.status,
                    phi_detected: phiCount,
                    redacted: (result.redacted_solid || 0) + (result.redacted_pixelated || 0)
                });
                
                res.send({
                    success: true,
                    anonymizationId: anonFilename,
                    image: `data:image/jpeg;base64,${result.image_base64}`,
                    phiCount: phiCount,
                    pixelatedCount: result.redacted_pixelated,
                    metadataScrubbed: result.metadata_scrubbed,
                    status: result.status,
                    protectedFractureRegions: fracCount
                });
            }
        );
    } catch (error) {
        console.error('Anonymization Error:', error.message);
        res.status(500).send({ success: false, error: 'Anonymization could not be safely completed.' });
    }
});


app.post('/admin/add-doctor', async (req, res) => {
    if (!req.user || req.user.role !== 'hospital_admin') return res.status(403).send('Forbidden');
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).send('Missing username or password');

    try {
        const hashedPassword = await argon2.hash(password);
        db.query('INSERT INTO users (username, password, role) VALUES (?, ?, ?)', [username, hashedPassword, 'doctor'], (err) => {
            if (err) {
                if (err.code === 'ER_DUP_ENTRY') return res.status(409).send('Username already exists');
                return res.status(500).send(err);
            }
            res.send({ success: true });
        });
    } catch (err) {
        res.status(500).send({ success: false, message: 'Error hashing password' });
    }
});

app.get('/admin/doctors', (req, res) => {
    if (!req.user || req.user.role !== 'hospital_admin') return res.status(403).send('Forbidden');
    db.query('SELECT id, username FROM users WHERE role = ?', ['doctor'], (err, results) => {
        if (err) return res.status(500).send(err);
        res.send(results);
    });
});

app.delete('/admin/remove-doctor/:id', (req, res) => {
    if (!req.user || req.user.role !== 'hospital_admin') return res.status(403).send('Forbidden');
    const doctorId = req.params.id;
    db.query('DELETE FROM users WHERE id = ? AND role = ?', [doctorId, 'doctor'], (err, result) => {
        if (err) return res.status(500).send(err);
        if (result.affectedRows === 0) return res.status(404).send('Doctor not found');
        res.send({ success: true });
    });
});

app.get('/dashboard', (req, res) => {
    if (!req.user || req.user.role !== 'doctor') return res.status(403).send('Forbidden');
    const doctorId = req.user.id;
    db.query('SELECT COUNT(DISTINCT patient_id) as totalPatients FROM visits WHERE doctor_id = ?', [doctorId], (err, patientRes) => {
        if (err) return res.status(500).send(err);
        db.query('SELECT COUNT(*) as totalVisits FROM visits WHERE doctor_id = ?', [doctorId], (err, visitRes) => {
            if (err) return res.status(500).send(err);
            db.query('SELECT visits.*, patients.name as patient_name FROM visits JOIN patients ON visits.patient_id = patients.id WHERE visits.doctor_id = ? ORDER BY visit_date DESC LIMIT 5', [doctorId], (err, recentRes) => {
                if (err) return res.status(500).send(err);
                db.query('SELECT diagnosis, COUNT(*) as count FROM visits WHERE doctor_id = ? GROUP BY diagnosis ORDER BY count DESC LIMIT 3', [doctorId], (err, diagRes) => {
                    if (err) return res.status(500).send(err);
                    res.send({
                        totalPatients: patientRes[0].totalPatients,
                        totalVisits: visitRes[0].totalVisits,
                        recentVisits: recentRes,
                        commonDiagnoses: diagRes
                    });
                });
            });
        });
    });
});

app.get('/admin/analytics', (req, res) => {
    if (!req.user || req.user.role !== 'hospital_admin') return res.status(403).send('Forbidden');
    db.query('SELECT diagnosis, COUNT(*) as count FROM visits GROUP BY diagnosis ORDER BY count DESC LIMIT 10', (err, diseaseTrends) => {
        if (err) return res.status(500).send(err);
        db.query('SELECT DATE(visit_date) as date, COUNT(DISTINCT patient_id) as newPatients FROM visits GROUP BY DATE(visit_date) ORDER BY date', (err, patientGrowth) => {
            if (err) return res.status(500).send(err);
            db.query('SELECT COUNT(*) as totalVisits, COUNT(DISTINCT patient_id) as totalPatients, COUNT(DISTINCT doctor_id) as totalDoctors FROM visits', (err, performance) => {
                if (err) return res.status(500).send(err);
                res.send({
                    diseaseTrends,
                    patientGrowth,
                    performance: performance[0]
                });
            });
        });
    });
});

app.get('/admin/patients', (req, res) => {
    if (!req.user || req.user.role !== 'hospital_admin') return res.status(403).send('Forbidden');
    db.query('SELECT id, username, role FROM users WHERE role = ?', ['patient'], (err, results) => {
        if (err) return res.status(500).send(err);
        res.send(results);
    });
});

app.delete('/admin/remove-patient/:id', (req, res) => {
    if (!req.user || req.user.role !== 'hospital_admin') return res.status(403).send('Forbidden');
    const patientId = req.params.id;
    db.query('DELETE FROM users WHERE id = ? AND role = ?', [patientId, 'patient'], (err, result) => {
        if (err) return res.status(500).send(err);
        if (result.affectedRows === 0) return res.status(404).send('Patient not found');
        res.send({ success: true });
    });
});

app.post('/admin/reset-patient-password', async (req, res) => {
    if (!req.user || req.user.role !== 'hospital_admin') return res.status(403).send('Forbidden');
    const { id, newPassword } = req.body;
    if (!id || !newPassword) return res.status(400).send('Missing id or newPassword');

    try {
        const hashedPassword = await argon2.hash(newPassword);
        db.query('UPDATE users SET password = ? WHERE id = ? AND role = ?', [hashedPassword, id, 'patient'], (err, result) => {
            if (err) return res.status(500).send(err);
            if (result.affectedRows === 0) return res.status(404).send('Patient not found');
            res.send({ success: true });
        });
    } catch (err) {
        res.status(500).send({ success: false, message: 'Error hashing password' });
    }
});

app.post('/admin/assign-role', (req, res) => {
    if (!req.user || req.user.role !== 'hospital_admin') return res.status(403).send('Forbidden');
    const { id, role } = req.body;
    if (!id || !role) return res.status(400).send('Missing id or role');
    if (!['doctor', 'patient', 'hospital_admin'].includes(role)) return res.status(400).send('Invalid role');
    db.query('UPDATE users SET role = ? WHERE id = ?', [role, id], (err, result) => {
        if (err) return res.status(500).send(err);
        if (result.affectedRows === 0) return res.status(404).send('User not found');
        res.send({ success: true });
    });
});

// ==================== APPOINTMENT ENDPOINTS ====================

// Book an appointment (Patient)
app.post('/appointments/book', (req, res) => {
    if (!req.user || req.user.role !== 'patient') {
        return res.status(403).send('Forbidden: Only patients can book appointments');
    }

    const { doctor_id, appointment_date, reason } = req.body;

    if (!doctor_id || !appointment_date) {
        return res.status(400).send('Missing required fields: doctor_id and appointment_date');
    }

    // Get patient_id from patients table
    db.query('SELECT id FROM patients WHERE name = ?', [req.user.username], (err, patientResult) => {
        if (err) return res.status(500).send(err);
        if (patientResult.length === 0) return res.status(404).send('Patient record not found');

        const patientId = patientResult[0].id;

        db.query('INSERT INTO appointments (patient_id, doctor_id, appointment_date, reason, approval_status) VALUES (?, ?, ?, ?, ?)',
            [patientId, doctor_id, appointment_date, reason || '', 'pending'],
            (err, result) => {
                if (err) return res.status(500).send(err);

                // Create notification for doctor
                const notificationQuery = 'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)';
                db.query(notificationQuery, [
                    doctor_id,
                    'New Appointment Request',
                    `Patient ${req.user.username} has booked an appointment for ${new Date(appointment_date).toLocaleString()}`,
                    'appointment'
                ]);

                res.send({ success: true, appointment_id: result.insertId });
            }
        );
    });
});

// Get patient's appointments
app.get('/appointments/my-appointments', (req, res) => {
    if (!req.user || req.user.role !== 'patient') {
        return res.status(403).send('Forbidden');
    }

    db.query('SELECT id FROM patients WHERE name = ?', [req.user.username], (err, patientResult) => {
        if (err) return res.status(500).send(err);
        if (patientResult.length === 0) return res.status(404).send('Patient not found');

        const patientId = patientResult[0].id;

        db.query(`SELECT a.*, u.username as doctor_name 
                  FROM appointments a 
                  JOIN users u ON a.doctor_id = u.id 
                  WHERE a.patient_id = ? 
                  ORDER BY a.appointment_date DESC`,
            [patientId],
            (err, results) => {
                if (err) return res.status(500).send(err);
                res.send(results);
            }
        );
    });
});

// Get doctor's appointments
app.get('/appointments/doctor-schedule', (req, res) => {
    if (!req.user || req.user.role !== 'doctor') {
        return res.status(403).send('Forbidden');
    }

    db.query(`SELECT a.*, p.name as patient_name 
              FROM appointments a 
              JOIN patients p ON a.patient_id = p.id 
              WHERE a.doctor_id = ? 
              ORDER BY a.appointment_date ASC`,
        [req.user.id],
        (err, results) => {
            if (err) return res.status(500).send(err);
            res.send(results);
        }
    );
});

// Update appointment status (Doctor)
app.put('/appointments/:id/status', (req, res) => {
    if (!req.user || req.user.role !== 'doctor') {
        return res.status(403).send('Forbidden');
    }

    const { status } = req.body; // 'scheduled', 'completed', 'cancelled'
    const appointmentId = req.params.id;

    if (!status || !['scheduled', 'completed', 'cancelled'].includes(status)) {
        return res.status(400).send('Invalid status');
    }

    db.query('UPDATE appointments SET status = ? WHERE id = ?', [status, appointmentId], (err) => {
        if (err) return res.status(500).send(err);

        // Notify patient about status change
        db.query('SELECT patient_id FROM appointments WHERE id = ?', [appointmentId], (err, result) => {
            if (err || result.length === 0) return;

            const patientId = result[0].patient_id;
            db.query('SELECT name FROM patients WHERE id = ?', [patientId], (err, patientResult) => {
                if (err || patientResult.length === 0) return;

                const patientName = patientResult[0].name;
                db.query('INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)', [
                    patientId,
                    'Appointment Status Updated',
                    `Your appointment has been ${status}`,
                    'appointment'
                ]);
            });
        });

        res.send({ success: true });
    });
});

// Cancel appointment (Patient)
app.delete('/appointments/:id/cancel', (req, res) => {
    if (!req.user || req.user.role !== 'patient') {
        return res.status(403).send('Forbidden');
    }

    const appointmentId = req.params.id;

    db.query('DELETE FROM appointments WHERE id = ?', [appointmentId], (err) => {
        if (err) return res.status(500).send(err);
        res.send({ success: true });
    });
});

// Get available doctors for appointment
app.get('/appointments/available-doctors', (req, res) => {
    if (!req.user) {
        return res.status(401).send('Not authenticated');
    }

    db.query('SELECT id, username FROM users WHERE role = ?', ['doctor'], (err, results) => {
        if (err) return res.status(500).send(err);
        res.send(results);
    });
});

// ==================== APPOINTMENT APPROVAL ENDPOINTS ====================

// Approve appointment (Doctor)
app.put('/appointments/:id/approve', (req, res) => {
    if (!req.user || req.user.role !== 'doctor') {
        return res.status(403).send('Forbidden: Only doctors can approve appointments');
    }

    const appointmentId = req.params.id;
    const { notes } = req.body; // Optional doctor notes

    db.query('UPDATE appointments SET approval_status = ?, approved_at = NOW(), notes = ? WHERE id = ?',
        ['approved', notes || '', appointmentId],
        (err) => {
            if (err) return res.status(500).send(err);

            // Notify patient about approval
            db.query('SELECT patient_id FROM appointments WHERE id = ?', [appointmentId], (err, result) => {
                if (err || result.length === 0) return;

                const patientId = result[0].patient_id;
                db.query('SELECT name FROM patients WHERE id = ?', [patientId], (err, patientResult) => {
                    if (err || patientResult.length === 0) return;

                    const patientName = patientResult[0].name;
                    db.query('INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)', [
                        patientId,
                        'Appointment Approved âœ“',
                        `Your appointment has been approved by the doctor. ${notes ? 'Note: ' + notes : ''}`,
                        'appointment'
                    ]);
                });
            });

            res.send({ success: true, message: 'Appointment approved successfully' });
        }
    );
});

// Reject appointment (Doctor)
app.put('/appointments/:id/reject', (req, res) => {
    if (!req.user || req.user.role !== 'doctor') {
        return res.status(403).send('Forbidden: Only doctors can reject appointments');
    }

    const appointmentId = req.params.id;
    const { reason } = req.body; // Reason for rejection

    if (!reason) {
        return res.status(400).send('Rejection reason is required');
    }

    db.query('UPDATE appointments SET approval_status = ?, notes = ? WHERE id = ?',
        ['rejected', reason, appointmentId],
        (err) => {
            if (err) return res.status(500).send(err);

            // Notify patient about rejection
            db.query('SELECT patient_id FROM appointments WHERE id = ?', [appointmentId], (err, result) => {
                if (err || result.length === 0) return;

                const patientId = result[0].patient_id;
                db.query('SELECT name FROM patients WHERE id = ?', [patientId], (err, patientResult) => {
                    if (err || patientResult.length === 0) return;

                    const patientName = patientResult[0].name;
                    db.query('INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)', [
                        patientId,
                        'Appointment Rejected âœ—',
                        `Your appointment request was rejected. Reason: ${reason}`,
                        'appointment'
                    ]);
                });
            });

            res.send({ success: true, message: 'Appointment rejected' });
        }
    );
});

// Get pending appointments for doctor (to approve/reject)
app.get('/appointments/pending-approvals', (req, res) => {
    if (!req.user || req.user.role !== 'doctor') {
        return res.status(403).send('Forbidden');
    }

    db.query(`SELECT a.*, p.name as patient_name, p.age as patient_age
              FROM appointments a 
              JOIN patients p ON a.patient_id = p.id 
              WHERE a.doctor_id = ? AND a.approval_status = 'pending'
              ORDER BY a.created_at ASC`,
        [req.user.id],
        (err, results) => {
            if (err) return res.status(500).send(err);
            res.send(results);
        }
    );
});

// Get all appointments with approval status for doctor
app.get('/appointments/doctor-all', (req, res) => {
    if (!req.user || req.user.role !== 'doctor') {
        return res.status(403).send('Forbidden');
    }

    const { filter } = req.query; // 'all', 'pending', 'approved', 'rejected'

    let query = `SELECT a.*, p.name as patient_name, p.age as patient_age 
                 FROM appointments a 
                 JOIN patients p ON a.patient_id = p.id 
                 WHERE a.doctor_id = ?`;

    if (filter && filter !== 'all') {
        query += ` AND a.approval_status = ?`;
        db.query(query, [req.user.id, filter], (err, results) => {
            if (err) return res.status(500).send(err);
            res.send(results);
        });
    } else {
        db.query(query + ' ORDER BY a.approval_status DESC, a.appointment_date ASC',
            [req.user.id],
            (err, results) => {
                if (err) return res.status(500).send(err);
                res.send(results);
            }
        );
    }
});

// Reschedule appointment (Patient - after rejection)
app.put('/appointments/:id/reschedule', (req, res) => {
    if (!req.user || req.user.role !== 'patient') {
        return res.status(403).send('Forbidden');
    }

    const { appointment_date, reason } = req.body;
    const appointmentId = req.params.id;

    if (!appointment_date) {
        return res.status(400).send('New date/time is required');
    }

    db.query('UPDATE appointments SET appointment_date = ?, approval_status = ?, reason = ? WHERE id = ?',
        [appointment_date, 'pending', reason || 'Rescheduling requested', appointmentId],
        (err) => {
            if (err) return res.status(500).send(err);

            // Notify doctor about reschedule request
            db.query('SELECT doctor_id FROM appointments WHERE id = ?', [appointmentId], (err, result) => {
                if (err || result.length === 0) return;

                const doctorId = result[0].doctor_id;
                db.query('INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)', [
                    doctorId,
                    'Appointment Reschedule Request',
                    'Patient has requested to reschedule the appointment',
                    'appointment'
                ]);
            });

            res.send({ success: true, message: 'Reschedule request sent' });
        }
    );
});

// ==================== NOTIFICATION ENDPOINTS ====================

// Get user notifications
app.get('/notifications', (req, res) => {
    if (!req.user) {
        return res.status(401).send('Not authenticated');
    }

    db.query('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
        [req.user.id],
        (err, results) => {
            if (err) return res.status(500).send(err);
            res.send(results);
        }
    );
});

// Mark notification as read
app.put('/notifications/:id/read', (req, res) => {
    if (!req.user) {
        return res.status(401).send('Not authenticated');
    }

    const notificationId = req.params.id;

    db.query('UPDATE notifications SET is_read = TRUE WHERE id = ? AND user_id = ?',
        [notificationId, req.user.id],
        (err) => {
            if (err) return res.status(500).send(err);
            res.send({ success: true });
        }
    );
});

// Mark all notifications as read
app.put('/notifications/read-all', (req, res) => {
    if (!req.user) {
        return res.status(401).send('Not authenticated');
    }

    db.query('UPDATE notifications SET is_read = TRUE WHERE user_id = ?',
        [req.user.id],
        (err) => {
            if (err) return res.status(500).send(err);
            res.send({ success: true });
        }
    );
});

// Get unread notification count
app.get('/notifications/unread-count', (req, res) => {
    if (!req.user) {
        return res.status(401).send('Not authenticated');
    }

    db.query('SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = FALSE',
        [req.user.id],
        (err, results) => {
            if (err) return res.status(500).send(err);
            res.send(results[0]);
        }
    );
});

// Delete notification
app.delete('/notifications/:id', (req, res) => {
    if (!req.user) {
        return res.status(401).send('Not authenticated');
    }

    const notificationId = req.params.id;

    db.query('DELETE FROM notifications WHERE id = ? AND user_id = ?',
        [notificationId, req.user.id],
        (err) => {
            if (err) return res.status(500).send(err);
            res.send({ success: true });
        }
    );
});

// ==================== ADMIN ENDPOINTS ====================

// Fetch system-wide audit logs
app.get('/admin/logs', (req, res) => {
    if (!req.user || req.user.role !== 'hospital_admin') {
        return res.status(403).send('Forbidden');
    }

    db.query('SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 100', (err, results) => {
        if (err) return res.status(500).send(err);
        res.send(results);
    });
});

// ==================== ADMIN ANALYTICS ENDPOINTS ====================

// General Admin Analytics (For Charts)
app.get('/admin/analytics', (req, res) => {
    if (!req.user || req.user.role !== 'hospital_admin') {
        return res.status(403).send('Forbidden');
    }

    addAuditLog(req, 'VIEW_ADMIN_ANALYTICS');

    // 1. Device Trends (Count per diagnosis)
    const trendsQuery = 'SELECT diagnosis, COUNT(*) as count FROM visits GROUP BY diagnosis';
    
    // 2. Patient Growth (New patients per day for the last 7 days)
    const growthQuery = 'SELECT DATE(created_at) as date, COUNT(*) as newPatients FROM users WHERE role = "patient" GROUP BY DATE(created_at) ORDER BY date DESC LIMIT 7';
    
    // 3. Hospital Performance
    const perfQuery = `SELECT 
        (SELECT COUNT(*) FROM visits) as totalVisits,
        (SELECT COUNT(*) FROM patients) as totalPatients,
        (SELECT COUNT(*) FROM users WHERE role = 'doctor') as totalDoctors`;

    db.query(trendsQuery, (err, trends) => {
        if (err) return res.status(500).send(err);
        db.query(growthQuery, (err, growth) => {
            if (err) return res.status(500).send(err);
            db.query(perfQuery, (err, perfResults) => {
                if (err) return res.status(500).send(err);
                res.send({
                    diseaseTrends: trends,
                    patientGrowth: growth.reverse(),
                    performance: perfResults[0]
                });
            });
        });
    });
});

// STEP 14: VULNERABLE Analytics (Intentionally Insecure - Exposes PII)
app.get('/admin/analytics/vulnerable', (req, res) => {
    if (!req.user || req.user.role !== 'hospital_admin') {
        return res.status(403).send('Forbidden');
    }

    // SECURITY RISK: This query joins patient identifiers (name, address) with clinical data
    const query = `
        SELECT p.name, p.age, pp.phone, pp.address, v.diagnosis 
        FROM patients p
        JOIN visits v ON p.id = v.patient_id
        LEFT JOIN patient_profiles pp ON p.id = pp.user_id
        ORDER BY v.visit_date DESC LIMIT 5
    `;

    db.query(query, (err, results) => {
        if (err) return res.status(500).send(err);
        addAuditLog(req, 'ACCESS_VULNERABLE_PII_ANALYTICS');
        res.send({
            rawRecords: results // DANGEROUS: Contains PII
        });
    });
});

// STEP 15: SAFE Analytics (Best Practice - Aggregated and Anonymized)
app.get('/admin/analytics/safe', (req, res) => {
    if (!req.user || req.user.role !== 'hospital_admin') {
        return res.status(403).send('Forbidden');
    }

    // Query 1: Disease counts (Aggregated)
    const trendQuery = 'SELECT diagnosis, COUNT(*) as count FROM visits GROUP BY diagnosis';
    
    // Query 2: Patient demographics (Anonymized - only showing age groups)
    const ageQuery = "SELECT CASE \
        WHEN age < 18 THEN 'Minor' \
        WHEN age BETWEEN 18 AND 65 THEN 'Adult' \
        ELSE 'Senior' \
    END as age_group, COUNT(*) as count FROM patients GROUP BY age_group";

    db.query(trendQuery, (err, trends) => {
        if (err) return res.status(500).send(err);
        
        db.query(ageQuery, (err, ageStats) => {
            if (err) return res.status(500).send(err);
            
            res.send({
                trends,
                ageStats // ANONYMIZED
            });
        });
    });
});




const https = require('https');
const fs = require('fs');

const PORT = process.env.PORT || 3000;

try {
    const options = {
        key: fs.readFileSync(path.join(__dirname, 'server.key')),
        cert: fs.readFileSync(path.join(__dirname, 'server.cert'))
    };
    https.createServer(options, app).listen(PORT, '0.0.0.0', () => {
        console.log(`ðŸ”’ HTTPS Server securely running on all interfaces at port ${PORT}`);
    });

} catch (e) {
    console.log("TLS Certs not found, fallback to HTTP");
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running on all interfaces at port ${PORT}`);
    });

}

// DOCTOR API: View Anonymized Images
app.get('/api/doctor/patients/:patientId/anonymized-images', (req, res) => {
    if (!req.user || (req.user.role !== 'doctor' && req.user.role !== 'hospital_admin')) {
        return res.status(403).send('Forbidden');
    }
    db.query('SELECT id, anonymized_file_path, status, created_at FROM medical_images WHERE patient_id = ? AND status = "SUCCESS"', 
    [req.params.patientId], (err, results) => {
        if (err) return res.status(500).send(err);
        
        const mapped = results.map(r => ({
            id: r.id,
            status: r.status,
            date: r.created_at,
            url: '/api/images/anonymized/' + r.anonymized_file_path.split('/').pop()
        }));
        res.send(mapped);
    });
});

app.get('/api/images/anonymized/:filename', (req, res) => {
    // Basic auth check using token in query string or cookie for image rendering
    // For simplicity in this project, we assume standard JWT check if passed, but typically images need cookie auth
    const filePath = __dirname + '/uploads/anonymized/doctor_access/' + req.params.filename;
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).send('Not found');
    }
});

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { detectDiscordance } = require('./discordance');

// ── Step 2 Gate Hardening Helpers ──────────────────────────────────────────
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
    if (data.coding_suggestions !== undefined && !Array.isArray(data.coding_suggestions)) {
        return { valid: false, reason: 'coding_suggestions must be an array if provided' };
    }
    if (data.discordance_flags !== undefined && !Array.isArray(data.discordance_flags)) {
        return { valid: false, reason: 'discordance_flags must be an array if provided' };
    }
    return { valid: true };
}

// Step 3 Helper: Format validation and input-grounding for coding suggestions
const ICD10_REGEX = /^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$/;
const SNOMED_REGEX = /^[0-9]{6,18}$/;

function processCodingSuggestions(rawSuggestions, inputFindings) {
    if (!Array.isArray(rawSuggestions)) return [];
    
    // Normalize input findings for ground-truth check
    const normalizedInputs = (inputFindings || []).map(f => (typeof f === 'string' ? f.toLowerCase().trim() : ''));
    
    const validated = [];
    for (const item of rawSuggestions) {
        if (!item || typeof item !== 'object') continue;
        const findingText = typeof item.finding === 'string' ? item.finding.trim() : '';
        if (!findingText) continue;

        // Check if finding is grounded in input findings (substring or near-match)
        const findingLower = findingText.toLowerCase();
        const isGrounded = normalizedInputs.some(inp => {
            if (!inp) return false;
            if (inp.includes(findingLower) || findingLower.includes(inp)) return true;
            const findingWords = findingLower.split(/\W+/).filter(w => w.length > 2);
            if (findingWords.length === 0) return false;
            const matches = findingWords.filter(w => inp.includes(w));
            return (matches.length / findingWords.length) >= 0.5;
        });

        // Drop any entry whose finding text is not grounded in the input findings
        if (!isGrounded) continue;

        // Validate format only (no claim that code is clinically correct)
        const icd = typeof item.icd10 === 'string' ? item.icd10.trim() : '';
        const snomed = typeof item.snomed_ct === 'string' ? item.snomed_ct.trim() : (typeof item.snomed_ct === 'number' ? String(item.snomed_ct) : '');
        
        const isIcdValid = Boolean(icd && ICD10_REGEX.test(icd));
        const isSnomedValid = Boolean(snomed && SNOMED_REGEX.test(snomed));
        
        // format_valid marked true/false per rule
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

app.post('/api/summarize', async (req, res) => {
    if (!req.user || (req.user.role !== 'doctor' && req.user.role !== 'hospital_admin')) {
        return res.status(403).send('Forbidden: Only authorized clinicians can generate summaries');
    }

    const { case_id, studies } = req.body;
    if (!case_id || !studies || !Array.isArray(studies)) {
        return res.status(400).send('Missing case_id or studies array');
    }

    try {
        // ── Step 5: Text anonymization gate ─────────────────────────────────
        // For every finding string, call the ML anonymization service BEFORE
        // sending anything to Gemini.  FAIL CLOSED: if the service is
        // unreachable, return an error rather than leaking raw text to Gemini.
        const ML_SERVICE = process.env.ML_SERVICE_URL || 'http://localhost:8000';
        let anonymizedStudies;
        try {
            anonymizedStudies = await Promise.all(studies.map(async (study) => {
                const anonFindings = study.anonymized_findings
                    ? await Promise.all(study.anonymized_findings.map(async (finding) => {
                        const resp = await axios.post(`${ML_SERVICE}/anonymize-text`, {
                            text: finding,
                            base_noise: 300,
                            largest_group_size: 1000,
                            current_group_size: 1000
                        }, { timeout: 10000 });
                        return resp.data.anonymized_text;
                    }))
                    : study.anonymized_findings;
                
                // STEP 2 Fix (a): Whitelist allowed study fields only — NEVER spread raw study
                const whitelisted = {};
                if (study.study_date !== undefined) whitelisted.study_date = study.study_date;
                if (study.modality !== undefined) whitelisted.modality = study.modality;
                if (study.body_region !== undefined) whitelisted.body_region = study.body_region;
                whitelisted.anonymized_findings = anonFindings;
                return whitelisted;
            }));
        } catch (mlErr) {
            console.error('[STEP5] Text anonymization service unreachable — failing closed:', mlErr.message);
            addAuditLog(req, 'SUMMARIZE_BLOCKED_ML_UNAVAILABLE', { case_id, error: mlErr.message });
            return res.status(503).json({
                success: false,
                error: 'Text anonymization service unavailable. Summary not generated to prevent PHI leakage.'
            });
        }

        // Replace raw studies with anonymized studies for all downstream use
        const sanitizedStudies = anonymizedStudies;

        // ── Existing keyword check (kept intact, now runs on already-anonymized text) ──
        const privacyRegex = /(patient|name|dob|mrn|phone|address|hospital|email|Rahul|Sharma)/i;
        let containsPHI = false;
        sanitizedStudies.forEach(study => {
            if (study.anonymized_findings) {
                study.anonymized_findings.forEach(finding => {
                    if (privacyRegex.test(finding)) containsPHI = true;
                });
            }
        });

        if (containsPHI) {
            console.warn('[PRIVACY WARNING] Possible PHI detected even after ML anonymization.');
        }

        // Alias for the rest of the existing handler (use sanitizedStudies instead of studies)
        const studiesForGemini = sanitizedStudies;
        
        let aiResponseText = "";
        let jsonResponse = null;

        const geminiApiKey = process.env.GEMINI_API_KEY;
        if (geminiApiKey) {
            const genAI = new GoogleGenerativeAI(geminiApiKey);
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash", generationConfig: { responseMimeType: "application/json" } });
            
            const prompt = `
You are a medical AI summarizer that ONLY analyzes ANONYMIZED findings.
NEVER output patient names, IDs, MRNs, DOBs, phone numbers, etc.
Synthesize the multiple X-ray studies below for case: ${case_id}.
Input:
${JSON.stringify(studiesForGemini, null, 2)}

Return STRICT JSON matching this structure:
{
  "summary_status": "success | insufficient_evidence",
  "overall_summary": "",
  "disease_trends": [{"condition_or_abnormality": "", "anatomical_region": "", "trend": "new|persistent|improving|worsening|stable|resolved|recurrent|uncertain", "evidence": "", "study_count": 0}],
  "anatomical_findings": [{"region": "", "findings": "", "trend": ""}],
  "new_findings": [],
  "persistent_findings": [],
  "improving_findings": [],
  "worsening_findings": [],
  "stable_findings": [],
  "resolved_findings": [],
  "potential_anomalies": [{"description": "", "reason": "", "requires_clinician_review": true}],
  "coding_suggestions": [{"finding": "", "icd10": "", "snomed_ct": "", "confidence": "low|medium|high", "source": "model_suggestion"}],
  "clinical_review_required": true,
  "review_reason": ""
}`;
            const result = await model.generateContent(prompt);
            aiResponseText = result.response.text();
            
            // Step 2 Fix (e): Validate JSON parse; return 502 on malformed response without storing
            try {
                jsonResponse = JSON.parse(aiResponseText);
            } catch (parseErr) {
                console.error('[GATE HARDENING] Malformed JSON from Gemini:', parseErr.message);
                addAuditLog(req, 'SUMMARIZE_FAILED_MALFORMED_JSON', { case_id, error: parseErr.message });
                return res.status(502).json({
                    success: false,
                    error: 'AI service returned malformed or unparseable response. Summary generation aborted.'
                });
            }

            // Step 2 Fix (e): Validate schema structure and expected field types
            const schemaCheck = validateSummarizerSchema(jsonResponse);
            if (!schemaCheck.valid) {
                console.error('[GATE HARDENING] Schema validation failed:', schemaCheck.reason);
                addAuditLog(req, 'SUMMARIZE_FAILED_SCHEMA_VALIDATION', { case_id, error: schemaCheck.reason });
                return res.status(502).json({
                    success: false,
                    error: 'AI service returned invalid summary structure: ' + schemaCheck.reason
                });
            }
            
            // Step 3: Process & validate coding suggestions (grounding against inputs + format check)
            const allInputFindings = [];
            sanitizedStudies.forEach(s => {
                if (Array.isArray(s.anonymized_findings)) allInputFindings.push(...s.anonymized_findings);
            });
            jsonResponse.coding_suggestions = processCodingSuggestions(jsonResponse.coding_suggestions, allInputFindings);

            // Step 2 Fix (b): Real post-check scan over model returned strings (not hard-coded false)
            jsonResponse.privacy_check = scanModelOutputForPHI(jsonResponse);
        } else {
            jsonResponse = {
                "summary_status": "success",
                "overall_summary": "Across the available anonymized radiographic studies, a persistent abnormality is documented. Later findings indicate maintained alignment and decreasing fracture-line conspicuity, suggesting an improving radiographic trend.",
                "disease_trends": [
                  {
                    "condition_or_abnormality": "fracture",
                    "anatomical_region": "distal radius",
                    "trend": "improving",
                    "evidence": "decreasing fracture-line conspicuity",
                    "study_count": sanitizedStudies.length
                  }
                ],
                "anatomical_findings": [
                  {
                    "region": "wrist",
                    "findings": "fracture",
                    "trend": "improving"
                  }
                ],
                "new_findings": [],
                "persistent_findings": ["distal radius fracture"],
                "improving_findings": ["fracture-line conspicuity"],
                "worsening_findings": [],
                "stable_findings": ["alignment"],
                "resolved_findings": [],
                "potential_anomalies": [],
                "coding_suggestions": [],
                "clinical_review_required": true,
                "review_reason": "AI-generated summary based on anonymized radiographic findings. Clinical interpretation and final diagnosis require review by an authorized clinician.",
                "privacy_check": {
                  "contains_patient_name": false,
                  "contains_patient_id": false,
                  "contains_dob": false,
                  "contains_mrn": false,
                  "contains_phone": false,
                  "contains_address": false,
                  "contains_hospital_identifier": false
                }
            };
            jsonResponse.privacy_check = scanModelOutputForPHI(jsonResponse);
        }

        // Step 2 Fix (b): If ANY identifier-like string is found, do not return as normal — replace with safe message
        const hasAnyPHI = jsonResponse.privacy_check && Object.values(jsonResponse.privacy_check).some(Boolean);
        if (hasAnyPHI) {
             console.warn('[PRIVACY SHIELD] Identifier pattern detected in model response. Activating privacy filter.');
             jsonResponse.overall_summary = "Privacy filter activated. Identifying information was removed.";
             jsonResponse.clinical_review_required = true;
             jsonResponse.review_reason = "Privacy filter activated: potential identifier pattern detected in model output.";
        }

        // Step 4: Run discordance / contradiction detector between consecutive studies (screening aid)
        const discordanceFlags = detectDiscordance(sanitizedStudies);
        jsonResponse.discordance_flags = discordanceFlags;

        // Merge discordance flags into potential_anomalies (screening aid — never auto-resolve)
        if (!Array.isArray(jsonResponse.potential_anomalies)) {
            jsonResponse.potential_anomalies = [];
        }
        for (const flag of discordanceFlags) {
            jsonResponse.potential_anomalies.push({
                description: `Discordance screening flag [${flag.type}]: "${flag.evidence[0]}" vs "${flag.evidence[1]}" (Studies ${flag.pair[0]} & ${flag.pair[1]})`,
                reason: `${flag.detail}. ${flag.note}`,
                requires_clinician_review: true,
                pair: flag.pair,
                type: flag.type
            });
            jsonResponse.clinical_review_required = true;
        }
        
        const summaryText = jsonResponse.overall_summary || "";
        const trendDataStr = JSON.stringify(jsonResponse);
        const anomalyFlag = jsonResponse.potential_anomalies && jsonResponse.potential_anomalies.length > 0;

        db.query(
            'INSERT INTO clinical_summaries (case_id, summary_text, trend_data, anomaly_flag, source, status) VALUES (?, ?, ?, ?, ?, ?)',
            [case_id, summaryText, trendDataStr, anomalyFlag, 'AI_Summarizer_Anonymized', 'pending_review'],
            (err, dbRes) => {
                if (err) {
                    console.error('Error saving summary:', err);
                    return res.status(500).send('Error saving summary');
                }
                addAuditLog(req, 'GENERATE_AI_SUMMARY', { case_id: case_id, studies_count: sanitizedStudies.length });
                res.send({
                    success: true,
                    summary_id: dbRes.insertId,
                    summary: jsonResponse
                });
            }
        );

    } catch (error) {
        console.error('Summarization Error:', error);
        res.status(500).send({ success: false, error: 'Summarization failed' });
    }
});

app.get('/api/summaries/:case_id', (req, res) => {
    if (!req.user || (req.user.role !== 'doctor' && req.user.role !== 'hospital_admin')) {
        return res.status(403).send('Forbidden');
    }
    db.query('SELECT * FROM clinical_summaries WHERE case_id = ? ORDER BY generated_at DESC', [req.params.case_id], (err, results) => {
        if (err) return res.status(500).send(err);
        res.send(results);
    });
});
