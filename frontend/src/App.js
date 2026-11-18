import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, LineChart, Line, PieChart, Pie, Cell } from 'recharts';
import './App.css';

import PatientRegistration from './PatientRegistration';
import PatientDashboard from './PatientDashboard';
import DoctorAppointments from './DoctorAppointments';
import LandingPage from './LandingPage';

axios.defaults.withCredentials = true;

function PatientProfile({ patientId, onBack, user }) {
    const [profile, setProfile] = useState(null);
    const [loading, setLoading] = useState(true);

    const [images, setImages] = useState([]);
    const [summary, setSummary] = useState(null);
    const [generatingSummary, setGeneratingSummary] = useState(false);

    React.useEffect(() => {
        if (user && (user.role === 'doctor' || user.role === 'hospital_admin')) {
            const fetchSummary = async () => {
                try {
                    const sumRes = await axios.get(`/api/summaries/${patientId}`);
                    if (sumRes.data && sumRes.data.length > 0) {
                        setSummary(JSON.parse(sumRes.data[0].trend_data));
                    }
                } catch(err) {}
            };
            fetchSummary();
        }
    }, [patientId, user]);

    const handleGenerateSummary = async () => {
        setGeneratingSummary(true);
        try {
            const studies = profile.visits.map(v => ({
                 study_id: "VISIT-" + v.id,
                 study_date: v.visit_date,
                 anonymized_findings: [v.diagnosis, v.notes]
            }));
            const res = await axios.post('/api/summarize', { case_id: patientId, studies });
            if (res.data.success) {
                setSummary(res.data.summary);
            }
        } catch (err) {
             alert('Error generating summary');
        }
        setGeneratingSummary(false);
    };

    React.useEffect(() => {
        const fetchProfile = async () => {
            try {
                const res = await axios.get(`/patients/${patientId}`);
                setProfile(res.data);
                
                try {
                    const imgRes = await axios.get(`/api/doctor/patients/${patientId}/anonymized-images`);
                    setImages(imgRes.data || []);
                } catch (imgErr) {
                    console.error('Could not fetch images', imgErr);
                }
            } catch (err) {
                setProfile(null);
            }
            setLoading(false);
        };
        fetchProfile();
    }, [patientId]);

    if (loading) return (
        <div className="pp-loading">
            <div className="pd-loading-spinner"></div>
            <p>Loading patient profile…</p>
        </div>
    );

    if (!profile) return (
        <div className="pp-error">
            <div className="pp-error__icon">⚠️</div>
            <p>Patient profile not found.</p>
            <button className="pp-back-btn" onClick={onBack}>← Back</button>
        </div>
    );

    const initials = profile.patient.name
        ? profile.patient.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
        : 'PT';

    const progressColor = (p) => ({
        completed: { bg: '#f0fdf4', color: '#166534', border: '#bbf7d0', text: '✓ Completed' },
        ongoing:   { bg: '#fff7ed', color: '#c2410c', border: '#fed7aa', text: '⟳ Ongoing' },
    }[p] || { bg: '#f8fafc', color: '#64748b', border: '#e2e8f0', text: p });

    return (
        <div className="pp-portal">
            {/* ── Header Bar ── */}
            <div className="pp-header">
                <button className="pp-back-btn" onClick={onBack}>← Back</button>
                <span className="pp-header__title">Patient Profile</span>
            </div>

            <div className="pp-main">
                {/* ── Patient Info Card ── */}
                <div className="pp-info-card">
                    <div className="pp-info-card__avatar">{initials}</div>
                    <div className="pp-info-card__body">
                        <div className="pp-info-card__name">{profile.patient.name}</div>
                        <div className="pp-info-card__meta">
                            <span className="pp-badge">Age {profile.patient.age}</span>
                            <span className="pp-badge pp-badge--visits">
                                🏥 {profile.visits.length} Visit{profile.visits.length !== 1 ? 's' : ''}
                            </span>
                        </div>
                    </div>
                </div>

                {/* ── Visit History ── */}
                <div className="pp-section-card">
                    <div className="pp-section-card__header">
                        <span className="pp-section-card__title">🕐 Visit History</span>
                        <span className="pp-section-card__count">{profile.visits.length} record{profile.visits.length !== 1 ? 's' : ''}</span>
                    </div>

                    {profile.visits.length === 0 ? (
                        <div className="pp-empty">
                            <div>📭</div>
                            <p>No visits recorded yet.</p>
                        </div>
                    ) : (
                        <div className="pp-timeline">
                            {profile.visits.map((v, idx) => {
                                const prog = progressColor(v.progress);
                                return (
                                    <div key={v.id} className="pp-timeline-item">
                                        <div className="pp-timeline-dot"></div>
                                        <div className="pp-visit-card">
                                            {/* Visit Header */}
                                            <div className="pp-visit-card__header">
                                                <div>
                                                    <div className="pp-visit-card__diagnosis">{v.diagnosis}</div>
                                                    <div className="pp-visit-card__meta">
                                                        <span>📅 {new Date(v.visit_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</span>
                                                        <span>👨‍⚕️ Dr. {v.doctor_name}</span>
                                                    </div>
                                                </div>
                                                <span
                                                    className="pp-progress-badge"
                                                    style={{ background: prog.bg, color: prog.color, borderColor: prog.border }}
                                                >
                                                    {prog.text}
                                                </span>
                                            </div>

                                            {/* Visit Details */}
                                            <div className="pp-visit-card__body">
                                                <div className="pp-visit-card__row">
                                                    <span className="pp-visit-card__key">Treatment</span>
                                                    <span className="pp-visit-card__val">{v.treatment}</span>
                                                </div>
                                                {v.prescription && (
                                                    <div className="pp-visit-card__pill pp-visit-card__pill--rx">
                                                        💊 <strong>Rx:</strong> {v.prescription}
                                                    </div>
                                                )}
                                                {v.report && (
                                                    <div className="pp-visit-card__row">
                                                        <span className="pp-visit-card__key">Report</span>
                                                        <a
                                                            href={v.report}
                                                            target="_blank"
                                                            rel="noreferrer"
                                                            className="pp-report-link"
                                                        >
                                                            📄 {v.report}
                                                        </a>
                                                    </div>
                                                )}
                                                {v.notes && (
                                                    <div className="pp-visit-card__pill pp-visit-card__pill--notes">
                                                        📝 {v.notes}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
                
                {/* ── Anonymized Medical Images ── */}
                <div className="pp-section-card" style={{ marginTop: '20px' }}>
                    <div className="pp-section-card__header">
                        <span className="pp-section-card__title">🖼️ Secure Medical Images</span>
                        <span className="pp-section-card__count">{images.length} record{images.length !== 1 ? 's' : ''}</span>
                    </div>

                    {images.length === 0 ? (
                        <div className="pp-empty">
                            <div>📭</div>
                            <p>No anonymized images available.</p>
                        </div>
                    ) : (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '20px', padding: '15px' }}>
                            {images.map((img) => (
                                <div key={img.id} style={{ border: '1px solid #e2e8f0', borderRadius: '8px', overflow: 'hidden', background: '#fff' }}>
                                    <div style={{ padding: '10px 15px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                        <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#334155' }}>Record #{img.id}</span>
                                        <span style={{ fontSize: '0.75rem', color: '#64748b' }}>{new Date(img.date).toLocaleDateString()}</span>
                                    </div>
                                    <div style={{ padding: '15px', textAlign: 'center' }}>
                                        <img src={img.url} alt={`Secure Medical Record ${img.id}`} style={{ maxWidth: '100%', height: 'auto', borderRadius: '4px', border: '1px solid #cbd5e1' }} />
                                        <div style={{ marginTop: '15px' }}>
                                            <a href={img.url} download={`secure_record_${img.id}.jpg`} style={{ display: 'inline-block', padding: '8px 16px', background: '#0ea5e9', color: '#fff', textDecoration: 'none', borderRadius: '6px', fontSize: '0.85rem', fontWeight: 500 }}>
                                                ↓ Download Secure Data
                                            </a>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* ── AI Summarization ── */}
                {user && (user.role === 'doctor' || user.role === 'hospital_admin') && (
                    <div className="pp-section-card" style={{ marginTop: '20px', borderTop: '4px solid #10b981' }}>
                        <div className="pp-section-card__header">
                            <span className="pp-section-card__title">🤖 ANONYMIZED CLINICAL TREND SUMMARY</span>
                            {!summary && <button onClick={handleGenerateSummary} disabled={generatingSummary} style={{ background: '#10b981', color: 'white', border: 'none', padding: '8px 16px', borderRadius: '4px', cursor: 'pointer' }}>{generatingSummary ? 'Generating...' : 'Generate AI Summary'}</button>}
                        </div>
                        {summary && (
                            <div style={{ padding: '15px' }}>
                                <h4>Overall Summary</h4>
                                <p>{summary.overall_summary}</p>

                                <h4>Disease / Abnormality Trends</h4>
                                <ul>
                                    {summary.disease_trends && summary.disease_trends.map((t, i) => (
                                        <li key={i}>{t.condition_or_abnormality} ({t.anatomical_region}) - <strong>{t.trend}</strong></li>
                                    ))}
                                </ul>

                                <h4>Anatomical Trends</h4>
                                <ul>
                                    {summary.anatomical_findings && summary.anatomical_findings.map((t, i) => (
                                        <li key={i}>{t.region}: {t.findings} - {t.trend}</li>
                                    ))}
                                </ul>

                                <h4>Findings Breakdown</h4>
                                <p><strong>New:</strong> {summary.new_findings?.join(', ') || 'None'}</p>
                                <p><strong>Persistent:</strong> {summary.persistent_findings?.join(', ') || 'None'}</p>
                                <p><strong>Improving:</strong> {summary.improving_findings?.join(', ') || 'None'}</p>
                                <p><strong>Worsening:</strong> {summary.worsening_findings?.join(', ') || 'None'}</p>
                                <p><strong>Stable:</strong> {summary.stable_findings?.join(', ') || 'None'}</p>

                                {summary.potential_anomalies && summary.potential_anomalies.length > 0 && (
                                    <div style={{ background: '#fee2e2', padding: '10px', marginTop: '10px', borderRadius: '4px' }}>
                                        <h4 style={{ color: '#ef4444', margin: '0 0 10px 0' }}>Potential Anomalies (Clinical Review Required)</h4>
                                        <ul style={{ margin: 0, paddingLeft: '20px' }}>
                                            {summary.potential_anomalies.map((a, i) => (
                                                <li key={i} style={{ color: '#b91c1c' }}>{a.description} - {a.reason}</li>
                                            ))}
                                        </ul>
                                    </div>
                                )}

                                {/* STEP 6: Diagnostic Coding Suggestions */}
                                {summary.coding_suggestions && summary.coding_suggestions.length > 0 && (
                                    <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '6px', padding: '12px', marginTop: '14px' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                                            <h4 style={{ margin: 0, color: '#166534', fontSize: '0.95rem' }}>📋 Diagnostic Coding Suggestions</h4>
                                            <span style={{ fontSize: '0.72rem', background: '#dcfce7', color: '#15803d', padding: '2px 8px', borderRadius: '4px', fontWeight: 600 }}>
                                                AI suggestion — clinician must verify
                                            </span>
                                        </div>
                                        <ul style={{ margin: 0, paddingLeft: '20px' }}>
                                            {summary.coding_suggestions.map((code, idx) => (
                                                <li key={idx} style={{ marginBottom: '6px', color: '#14532d', fontSize: '0.85rem' }}>
                                                    <strong>{code.finding}</strong>: 
                                                    {code.icd10 && <span> ICD-10: <code>{code.icd10}</code></span>}
                                                    {code.snomed_ct && <span> | SNOMED CT: <code>{code.snomed_ct}</code></span>}
                                                    <span style={{ marginLeft: '8px', fontSize: '0.75rem', color: '#4b5563' }}>({code.confidence} confidence)</span>
                                                    {!code.format_valid && <span style={{ marginLeft: '6px', color: '#b91c1c', fontSize: '0.72rem' }}>⚠️ format unverified</span>}
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}

                                {/* STEP 6: Longitudinal Study Discordance Flags */}
                                {summary.discordance_flags && summary.discordance_flags.length > 0 && (
                                    <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '6px', padding: '12px', marginTop: '14px' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                                            <h4 style={{ margin: 0, color: '#92400e', fontSize: '0.95rem' }}>⚠️ Longitudinal Study Discordance Flags</h4>
                                            <span style={{ fontSize: '0.72rem', background: '#fef3c7', color: '#b45309', padding: '2px 8px', borderRadius: '4px', fontWeight: 600 }}>
                                                AI suggestion — clinician must verify
                                            </span>
                                        </div>
                                        <ul style={{ margin: 0, paddingLeft: '20px' }}>
                                            {summary.discordance_flags.map((d, idx) => (
                                                <li key={idx} style={{ marginBottom: '6px', color: '#78350f', fontSize: '0.85rem' }}>
                                                    <strong>[{d.type.replace('_', ' ').toUpperCase()}]</strong> (Studies {d.pair ? `${d.pair[0]} & ${d.pair[1]}` : ''}): {d.detail || ''}
                                                    {d.evidence && (
                                                        <div style={{ fontSize: '0.78rem', color: '#57534e', marginTop: '2px' }}>
                                                            <em>Evidence: "{d.evidence[0]}" vs "{d.evidence[1]}"</em>
                                                        </div>
                                                    )}
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                                
                                {summary.clinical_review_required && (
                                    <p style={{ marginTop: '15px', fontStyle: 'italic', color: '#64748b' }}>⚠️ {summary.review_reason}</p>
                                )}
                            </div>
                        )}
                    </div>
                )}

            </div>
        </div>
    );
}


function App() {
    const [user, setUser] = useState(null);
    const [patients, setPatients] = useState([]);
    const [visits, setVisits] = useState([]);
    const [showRegistration, setShowRegistration] = useState(false);
    const [showLanding, setShowLanding] = useState(true);
    const [checkingSession, setCheckingSession] = useState(true);

    useEffect(() => {
        const checkSession = async () => {
            try {
                const res = await axios.get('/me');
                if (res.data.success) {
                    setUser(res.data.user);
                    setShowLanding(false);
                    fetchData(res.data.user);
                }
            } catch (err) { }
            setCheckingSession(false);
        };
        checkSession();
    }, []);

    const handleLogin = async (username, password) => {
        try {
            // Collect device fingerprint data
            const fingerprintData = {
                userAgent: navigator.userAgent,
                screenRes: `${window.screen.width}x${window.screen.height}`,
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
            };

            const res = await axios.post('/login', { 
                username, 
                password,
                fingerprintData 
            });
            
            if (res.data.success) {
                if (res.data.fingerprintMismatch) {
                    alert('⚠️ SECURITY WARNING: New device detected for this account. This event has been logged.');
                }
                setUser(res.data.user);
                fetchData(res.data.user);
            } else {
                alert('Invalid credentials');
            }
        } catch (err) {
            alert('Error during login');
        }
    };


    const fetchData = async (user) => {
        try {
            const res = await axios.get('/patients');
            if (user.role === 'patient') {
                setVisits(res.data);
            } else {
                setPatients(res.data);
            }
        } catch (err) {
            alert('Error fetching data');
        }
    };

    const addVisit = async (patient_id, diagnosis, treatment, prescription, report, progress, notes) => {
        try {
            // Ensure patient_id is a number
            const numericPatientId = parseInt(patient_id, 10);
            if (isNaN(numericPatientId)) {
                alert('Please select a valid patient');
                return;
            }

            const response = await axios.post('/visits', {
                patient_id: numericPatientId,
                diagnosis,
                treatment,
                prescription,
                report,
                progress,
                notes
            });
            if (response.data.success) {
                alert('Visit added successfully!');
            }
        } catch (err) {
            console.error('Error adding visit:', err);
            const errorMessage = err.response?.data || err.message || 'Error adding visit';
            alert(errorMessage);
        }
    };

    const logout = () => {
        setUser(null);
        setPatients([]);
        setVisits([]);
    };

    const handleLogout = async () => {
        try { await axios.post('/logout'); } catch (err) { }
        logout();
        setShowLanding(true);
    };

    if (checkingSession) return <div>Loading session...</div>;

    return (
        <div className="App">
            {showLanding && !user ? (
                <LandingPage onGetStarted={() => setShowLanding(false)} />
            ) : !user ? (
                showRegistration ? (
                    <PatientRegistration
                        onRegister={() => setShowRegistration(false)}
                        onBackToLogin={() => setShowRegistration(false)}
                    />
                ) : (
                    <Login
                        onLogin={handleLogin}
                        onShowRegistration={() => setShowRegistration(true)}
                    />
                )
            ) : (
                user.role === 'patient' ? (
                    <PatientDashboard
                        user={user}
                        onLogout={handleLogout}
                    />
                ) : (
                    <Dashboard
                        user={user}
                        patients={patients}
                        visits={visits}
                        onAddVisit={addVisit}
                        onLogout={handleLogout}
                    />
                )
            )}
        </div>
    );
}

function Login({ onLogin, onShowRegistration }) {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const submit = async (e) => {
        e.preventDefault();
        setError('');
        setLoading(true);
        try {
            await onLogin(username, password);
        } catch (err) {
            setError('Invalid credentials. Please try again.');
        }
        setLoading(false);
    };

    return (
        <div className="login-page">
            {/* ── Left Hero Panel ── */}
            <div className="login-hero">
                <div className="login-hero__inner">
                    <div className="login-hero__logo">
                        <span className="login-hero__logo-icon">🏥</span>
                        <span className="login-hero__logo-text">SUPMS<span className="login-hero__logo-dot">.</span></span>
                    </div>
                    <h1 className="login-hero__title">
                        Secure Unified<br />Patient Medical<br />History System
                    </h1>
                    <p className="login-hero__sub">
                        Trusted by doctors, patients and hospital administrators for seamless, secure healthcare management.
                    </p>
                    <div className="login-hero__features">
                        {[
                            { icon: '🔒', text: 'End-to-end secure records' },
                            { icon: '📊', text: 'Real-time analytics' },
                            { icon: '📅', text: 'Smart appointment scheduling' },
                        ].map(f => (
                            <div key={f.text} className="login-hero__feature">
                                <span className="login-hero__feature-icon">{f.icon}</span>
                                <span>{f.text}</span>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            {/* ── Right Login Card ── */}
            <div className="login-right">
                <div className="login-card">
                    <div className="login-card__header">
                        <h2 className="login-card__title">Welcome back</h2>
                        <p className="login-card__sub">Sign in to your account to continue</p>
                    </div>

                    {error && (
                        <div className="login-card__error">⚠️ {error}</div>
                    )}

                    <form onSubmit={submit} className="login-card__form">
                        <div className="login-card__group">
                            <label className="login-card__label">Username</label>
                            <div className="login-card__input-wrap">
                                <span className="login-card__input-icon">👤</span>
                                <input
                                    type="text"
                                    placeholder="Enter your username"
                                    value={username}
                                    onChange={e => setUsername(e.target.value)}
                                    required
                                    className="login-card__input"
                                    autoComplete="username"
                                />
                            </div>
                        </div>

                        <div className="login-card__group">
                            <label className="login-card__label">Password</label>
                            <div className="login-card__input-wrap">
                                <span className="login-card__input-icon">🔑</span>
                                <input
                                    type="password"
                                    placeholder="Enter your password"
                                    value={password}
                                    onChange={e => setPassword(e.target.value)}
                                    required
                                    className="login-card__input"
                                    autoComplete="current-password"
                                />
                            </div>
                        </div>

                        <button type="submit" disabled={loading} className="login-card__btn">
                            {loading ? (
                                <span className="login-card__btn-loading">
                                    <span className="login-btn-spinner"></span> Signing in…
                                </span>
                            ) : 'Sign In →'}
                        </button>
                    </form>

                    <div className="login-card__register">
                        <span>Don't have an account?</span>
                        <button onClick={onShowRegistration} className="login-card__register-btn">
                            Register as Patient
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}


function Dashboard({ user, patients, visits, onAddVisit, onLogout }) {
    const [patientId, setPatientId] = useState('');
    const [diagnosis, setDiagnosis] = useState('');
    const [treatment, setTreatment] = useState('');
    const [prescription, setPrescription] = useState('');
    const [report, setReport] = useState('');
    const [reportFile, setReportFile] = useState(null);
    const [progress, setProgress] = useState('ongoing');
    const [notes, setNotes] = useState('');
    const [search, setSearch] = useState('');
    const [searchResults, setSearchResults] = useState([]);
    const [searching, setSearching] = useState(false);
    const [profileId, setProfileId] = useState(null);
    const [diagPatientId, setDiagPatientId] = useState('');
    const [diagDiagnosis, setDiagDiagnosis] = useState('');
    const [diagSubmitting, setDiagSubmitting] = useState(false);
    const [dashboardStats, setDashboardStats] = useState(null);
    const [analytics, setAnalytics] = useState(null);
    const [auditLogs, setAuditLogs] = useState([]);
    const [vulnerableAnalytics, setVulnerableAnalytics] = useState(null);
    const [safeAnalytics, setSafeAnalytics] = useState(null);
    
    // Anonymization state (existing — unchanged)
    const [anonPatientId, setAnonPatientId] = useState('');
    const [anonImageFile, setAnonImageFile] = useState(null);
    const [anonSubmitting, setAnonSubmitting] = useState(false);
    const [anonResult, setAnonResult] = useState(null);
    const [anonError, setAnonError] = useState('');

    const submitAnonymization = async (e) => {
        e.preventDefault();
        setAnonSubmitting(true);
        setAnonResult(null);
        setAnonError('');
        
        const formData = new FormData();
        formData.append('patientId', anonPatientId);
        formData.append('image', anonImageFile);
        
        try {
            const response = await axios.post('/api/admin/anonymization/images', formData, {
                headers: { 'Content-Type': 'multipart/form-data' }
            });
            if (response.data.success) {
                setAnonResult(response.data);
            }
        } catch (err) {
            setAnonError(err.response?.data?.error || err.message || 'Anonymization failed');
        }
        setAnonSubmitting(false);
    };

    // ── NEW: Demo 3-panel pipeline state ────────────────────────────────────
    const [demoDatasetImages, setDemoDatasetImages] = useState([]);
    const [demoSelectedImage, setDemoSelectedImage] = useState('');
    const [demoUploadFile, setDemoUploadFile] = useState(null);
    const [demoStatus, setDemoStatus] = useState(''); // step message
    const [demoResult, setDemoResult] = useState(null);
    const [demoError, setDemoError] = useState('');
    const [demoRunning, setDemoRunning] = useState(false);

    const DEMO_STEPS = [
        'Loading medical image...',
        'Generating synthetic PHI...',
        'Running OCR detection...',
        'Anonymizing image...',
        'Analysis complete'
    ];

    const fetchDemoImages = React.useCallback(async () => {
        try {
            const res = await axios.get('/api/demo/dataset-images');
            if (res.data.images && res.data.images.length > 0) {
                setDemoDatasetImages(res.data.images);
                setDemoSelectedImage(prev => prev || res.data.images[0]);
            }
        } catch (_) { /* ML service may not be running yet */ }
    }, []);

    const submitDemo = async (e) => {
        e.preventDefault();
        setDemoRunning(true);
        setDemoResult(null);
        setDemoError('');

        const formData = new FormData();
        if (demoUploadFile) {
            formData.append('file', demoUploadFile);
        } else if (demoSelectedImage) {
            formData.append('dataset_image', demoSelectedImage);
        } else {
            setDemoError('Please select a dataset image or upload an X-ray.');
            setDemoRunning(false);
            return;
        }

        // Animate steps
        for (let i = 0; i < DEMO_STEPS.length - 1; i++) {
            setDemoStatus(DEMO_STEPS[i]);
            await new Promise(r => setTimeout(r, 600));
        }

        try {
            const response = await axios.post('/api/demo/anonymization-demo', formData, {
                headers: { 'Content-Type': 'multipart/form-data' }
            });
            setDemoResult(response.data);
            setDemoStatus(DEMO_STEPS[DEMO_STEPS.length - 1]);
        } catch (err) {
            setDemoError(err.response?.data?.error || err.message || 'Demo pipeline failed');
            setDemoStatus('');
        }
        setDemoRunning(false);
    };
    // ────────────────────────────────────────────────────────────────────────

    React.useEffect(() => {
        if (user && user.role === 'doctor') {
            const fetchStats = async () => {
                try {
                    const res = await axios.get('/dashboard');
                    setDashboardStats(res.data);
                } catch (err) {
                    console.log('Error fetching dashboard stats');
                }
            };
            fetchStats();
        }
        if (user && user.role === 'hospital_admin') {
            fetchDemoImages();
            const fetchAdminData = async () => {
                 try {
                    const [resAnalytics, resLogs, resVulnerable, resSafe] = await Promise.all([
                        axios.get('/admin/analytics'),
                        axios.get('/admin/logs'),
                        axios.get('/admin/analytics/vulnerable'),
                        axios.get('/admin/analytics/safe')
                    ]);
                    setAnalytics(resAnalytics.data);
                    setAuditLogs(resLogs.data);
                    setVulnerableAnalytics(resVulnerable.data);
                    setSafeAnalytics(resSafe.data);
                } catch (err) {

                    console.log('Error fetching admin data');
                }
            };
            fetchAdminData();
        }

    }, [user, fetchDemoImages]);


    const submitVisit = async (e) => {
        e.preventDefault();
        
        const formData = new FormData();
        formData.append('patient_id', patientId);
        formData.append('diagnosis', diagnosis);
        formData.append('treatment', treatment);
        formData.append('prescription', prescription);
        formData.append('progress', progress);
        formData.append('notes', notes);
        
        // If they provided a file, append it as 'reportFile'
        if (reportFile) {
            formData.append('reportFile', reportFile);
        } else if (report) {
            // Otherwise fallback to whatever text was in the URL field
            formData.append('report', report);
        }

        try {
            const response = await axios.post('/visits', formData, {
                headers: { 'Content-Type': 'multipart/form-data' }
            });
            if (response.data.success) {
                alert('Visit added successfully!');
                // Reset form
                setPatientId('');
                setDiagnosis('');
                setTreatment('');
                setPrescription('');
                setReport('');
                setReportFile(null);
                setProgress('ongoing');
                setNotes('');
                // optionally we could manually trigger onAddVisit to update parent state, 
                // but since App.js passed `onAddVisit` we might need to alter it there ideally.
                // However, making the direct post call here simplifies the FormData transport.
                // Re-fetch stats immediately:
                const resStats = await axios.get('/dashboard');
                setDashboardStats(resStats.data);
            }
        } catch (err) {
            console.error('Error adding visit:', err);
            const errorMessage = err.response?.data || err.message || 'Error adding visit';
            alert(errorMessage);
        }
    };

    const submitDiagnosis = async (e) => {
        e.preventDefault();
        setDiagSubmitting(true);
        try {
            // Step 1: get HMAC signature from server (secret stays server-side)
            const signRes = await axios.post('/api/diagnosis/sign', {
                patient_id: diagPatientId,
                diagnosis: diagDiagnosis
            });
            const { signature } = signRes.data;

            // Step 2: submit with the signature for integrity verification
            const response = await axios.post('/api/diagnosis/submit', {
                patient_id: diagPatientId,
                diagnosis: diagDiagnosis,
                signature
            });
            if (response.data.success) {
                alert('Diagnosis submitted successfully! ' + (response.data.tampered ? '(Data Integrity Risk Demonstrated)' : ''));
                setDiagDiagnosis('');
                // Refresh dashboard stats to show the update if necessary
                const resStats = await axios.get('/dashboard');
                setDashboardStats(resStats.data);
            }
        } catch (err) {
            alert('Error submitting diagnosis: ' + (err.response?.data?.message || err.response?.data || err.message));
        }
        setDiagSubmitting(false);
    };

    const handleSearch = async (e) => {
        e.preventDefault();
        if (!search) return;
        setSearching(true);
        try {
            const res = await axios.get(`/patients/search?query=${encodeURIComponent(search)}`);
            setSearchResults(res.data);
        } catch (err) {
            alert('Error searching patients');
        }
        setSearching(false);
    };

    if (profileId) {
        return <PatientProfile patientId={profileId} onBack={() => setProfileId(null)} user={user} />;
    }

    // ── HOSPITAL ADMIN layout — professional portal ────────────────────────
    if (user.role === 'hospital_admin') {
        return (
            <div className="admin-portal-wrap">
                {/* ── Topbar ── */}
                <nav className="admin-topbar">
                    <div className="admin-topbar__brand">
                        <div className="admin-topbar__logo">🏛️</div>
                        <span className="admin-topbar__name">
                            SUPMS<span>.</span>
                        </span>
                    </div>
                    <div className="admin-topbar__actions">
                        <span className="admin-topbar__role">Hospital Admin</span>
                        <button onClick={onLogout} className="logout-btn">Sign Out</button>
                    </div>
                </nav>

                {/* ── Main ── */}
                <main className="admin-main">
                    <p className="admin-section-title">Analytics &amp; Administration</p>
                    <p className="admin-section-sub">Hospital-wide overview, performance metrics, and patient management.</p>

                    {/* ── Stat Cards ── */}
                    {analytics && (
                        <div className="admin-stats-row">
                            <div className="admin-stat-card">
                                <div className="admin-stat-card__icon admin-stat-card__icon--purple">🏥</div>
                                <div>
                                    <div className="admin-stat-card__val">{analytics.performance.totalVisits}</div>
                                    <div className="admin-stat-card__label">Total Visits</div>
                                </div>
                            </div>
                            <div className="admin-stat-card">
                                <div className="admin-stat-card__icon admin-stat-card__icon--blue">👥</div>
                                <div>
                                    <div className="admin-stat-card__val">{analytics.performance.totalPatients}</div>
                                    <div className="admin-stat-card__label">Total Patients</div>
                                </div>
                            </div>
                            <div className="admin-stat-card">
                                <div className="admin-stat-card__icon admin-stat-card__icon--green">👨‍⚕️</div>
                                <div>
                                    <div className="admin-stat-card__val">{analytics.performance.totalDoctors}</div>
                                    <div className="admin-stat-card__label">Total Doctors</div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* ── Charts ── */}
                    {analytics && (
                        <>
                            <div className="admin-chart-card">
                                <div className="admin-chart-card__title">📊 Disease Trends</div>
                                <BarChart width={600} height={280} data={analytics.diseaseTrends}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                                    <XAxis dataKey="diagnosis" tick={{ fontSize: 12, fill: '#64748b' }} />
                                    <YAxis tick={{ fontSize: 12, fill: '#64748b' }} />
                                    <Tooltip contentStyle={{ borderRadius: '10px', border: '1px solid #e2e8f0', fontSize: '0.85rem' }} />
                                    <Legend />
                                    <Bar dataKey="count" fill="#1a6fd4" radius={[4, 4, 0, 0]} />
                                </BarChart>
                            </div>

                            <div className="admin-chart-card">
                                <div className="admin-chart-card__title">📈 Patient Growth Over Time</div>
                                <LineChart width={600} height={260} data={analytics.patientGrowth}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                                    <XAxis dataKey="date" tick={{ fontSize: 12, fill: '#64748b' }} />
                                    <YAxis tick={{ fontSize: 12, fill: '#64748b' }} />
                                    <Tooltip contentStyle={{ borderRadius: '10px', border: '1px solid #e2e8f0', fontSize: '0.85rem' }} />
                                    <Legend />
                                    <Line type="monotone" dataKey="newPatients" stroke="#0891b2" strokeWidth={2} dot={{ fill: '#0891b2', r: 4 }} />
                                </LineChart>
                            </div>

                            {/* 🔍 Security Audit Trail Section */}
                            <div className="admin-audit-card">
                                <div className="admin-audit-card__header">
                                    <span className="admin-audit-card__title">🕵️‍♂️ Security Audit Trail</span>
                                    <span className="admin-badge admin-badge--security">LIVE MONITORING</span>
                                </div>
                                <div className="admin-audit-table-wrap">
                                    <table className="admin-audit-table">
                                        <thead>
                                            <tr>
                                                <th>Time</th>
                                                <th>User</th>
                                                <th>Action</th>
                                                <th>IP Address</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {auditLogs.map(log => (
                                                <tr key={log.id} className={log.action.includes('ALERT') ? 'admin-row--alert' : ''}>
                                                    <td className="admin-td--time">{new Date(log.timestamp).toLocaleTimeString()}</td>
                                                    <td><strong>{log.username}</strong></td>
                                                    <td>
                                                        <span className={`admin-action-tag ${log.action.includes('ALERT') ? 'admin-action-tag--danger' : ''}`}>
                                                            {log.action}
                                                        </span>
                                                    </td>
                                                    <td className="admin-td--ip">{log.ip_address}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>

                            {/* 🚨 Vulnerable Analytics Section (Privacy Risk Demo) */}
                            {vulnerableAnalytics && (
                                <div className="admin-vulnerable-card">
                                    <div className="admin-audit-card__header">
                                        <span className="admin-audit-card__title">🚨 Privacy Violation Risk Demo (Analytics)</span>
                                        <span className="admin-badge admin-badge--security">VULNERABILITY: EXPOSED PII</span>
                                    </div>
                                    <div className="admin-vulnerable-content">
                                        <div className="vulnerable-summary">
                                            <p>This analytics report contains <strong>raw patient data</strong> mixed with statistics. This is a critical security flaw.</p>
                                        </div>
                                        <table className="admin-audit-table">
                                            <thead>
                                                <tr>
                                                    <th>Patient Name</th>
                                                    <th>Diagnosis</th>
                                                    <th>Contact / Address</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {vulnerableAnalytics.rawRecords.map((rec, i) => (
                                                    <tr key={i}>
                                                        <td><strong>{rec.name}</strong> (Age: {rec.age})</td>
                                                        <td>{rec.diagnosis}</td>
                                                        <td style={{ fontSize: '0.75rem', color: '#64748b' }}>
                                                            {rec.phone || 'N/A'} | {rec.address || 'N/A'}
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            )}

                            {/* ✅ Privacy-Safe Analytics Section (Best Practice) */}
                            {safeAnalytics && (
                                <div className="admin-safe-card">
                                    <div className="admin-audit-card__header">
                                        <span className="admin-audit-card__title">✅ Privacy-Safe Analytics View</span>
                                        <span className="admin-badge admin-badge--success">BEST PRACTICE: AGGREGATED DATA</span>
                                    </div>
                                    <div className="admin-safe-grid">
                                        <div className="safe-chart-item" style={{display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
                                            <h4>🩺 Disease Trends (Anonymized)</h4>
                                            <BarChart width={400} height={250} data={safeAnalytics.trends} layout="vertical" margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                                                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={true} vertical={false} />
                                                <XAxis type="number" hide />
                                                <YAxis dataKey="diagnosis" type="category" tick={{ fontSize: 12, fill: '#10b981', fontWeight: 600 }} width={120} axisLine={false} tickLine={false} />
                                                <Tooltip cursor={{fill: 'transparent'}} contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
                                                <Bar dataKey="count" fill="#10b981" radius={[0, 4, 4, 0]} barSize={20} />
                                            </BarChart>
                                        </div>
                                        <div className="safe-chart-item" style={{display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
                                            <h4>👥 Patient Demographics (Anonymized)</h4>
                                            <PieChart width={300} height={250}>
                                                <Pie
                                                    data={safeAnalytics.ageStats}
                                                    cx="50%"
                                                    cy="50%"
                                                    innerRadius={60}
                                                    outerRadius={80}
                                                    fill="#8884d8"
                                                    paddingAngle={5}
                                                    dataKey="count"
                                                    nameKey="age_group"
                                                    label={({age_group, percent}) => `${age_group} ${(percent * 100).toFixed(0)}%`}
                                                >
                                                    {safeAnalytics.ageStats.map((entry, index) => (
                                                        <Cell key={`cell-${index}`} fill={['#10b981', '#34d399', '#059669'][index % 3]} />
                                                    ))}
                                                </Pie>
                                                <Tooltip contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
                                            </PieChart>
                                        </div>
                                    </div>
                                    <div className="safe-notice">
                                        🛡️ This view contains <strong>zero PII</strong>. No names, addresses, or phone numbers are transmitted.
                                    </div>
                                </div>
                            )}
                        </>
                    )}




                    {/* ── Patient Search & List ── */}
                    <div className="admin-patients-card">
                        <div className="section-header">
                            <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: '#0f172a' }}>👥 Patient Records</h3>
                        </div>
                        <form onSubmit={handleSearch} className="search-form" style={{ marginBottom: 16, marginTop: 16 }}>
                            <input type="text" placeholder="🔍  Search patients by name or ID…" value={search} onChange={e => setSearch(e.target.value)} />
                            <button type="submit" disabled={searching}>{searching ? 'Searching…' : 'Search'}</button>
                        </form>
                        {searchResults.length > 0 && (
                            <div className="search-results">
                                <h3>Search Results</h3>
                                {searchResults.map(p => (
                                    <div key={p.id} className="patient-card" onClick={() => setProfileId(p.id)}>
                                        {p.name} · Age {p.age}
                                    </div>
                                ))}
                            </div>
                        )}
                        <div className="patients-list">
                            {patients.map(p => (
                                <div key={p.id} className="patient-card" onClick={() => setProfileId(p.id)}>
                                    {p.name} · Age {p.age}
                                </div>
                            ))}
                        </div>
                        
                        {/* ── ADMIN ONLY: Medical Data Anonymization (existing upload flow) ── */}
                        <div className="add-visit" style={{ marginTop: '30px', borderTop: '2px solid #e2e8f0', paddingTop: '20px' }}>
                            <h2>Medical Data Anonymization</h2>
                            <p style={{ fontSize: '0.85rem', color: '#64748b', marginBottom: '15px' }}>
                                Securely redact Protected Health Information (PHI) from medical images before storage or sharing.
                            </p>
                            <form onSubmit={submitAnonymization} className="visit-form">
                                <select value={anonPatientId} onChange={e => setAnonPatientId(e.target.value)} required>
                                    <option value="">Select Patient</option>
                                    {patients.map(p => (
                                        <option key={p.id} value={p.id}>{p.name} (ID: {p.id})</option>
                                    ))}
                                </select>
                                <div className="file-upload-group" style={{ marginBottom: '15px' }}>
                                    <label style={{ fontSize: '0.85rem', color: '#64748b', marginBottom: '4px', display: 'block', fontWeight: 600 }}>
                                        Upload RAW Medical Image (X-ray, Scan)
                                    </label>
                                    <input 
                                        type="file" 
                                        onChange={e => setAnonImageFile(e.target.files[0])} 
                                        accept=".png,.jpg,.jpeg"
                                        required
                                        style={{ padding: '8px', border: '1px solid #e2e8f0', borderRadius: '8px', width: '100%', background: '#fff' }}
                                    />
                                </div>
                                <button type="submit" disabled={anonSubmitting} style={{ background: '#10b981', color: 'white' }}>
                                    {anonSubmitting ? 'Processing ML Pipeline...' : 'Process & Anonymize'}
                                </button>
                                {anonError && <p style={{ color: '#ef4444', marginTop: '10px' }}>{anonError}</p>}
                            </form>

                            {anonResult && (
                                <div style={{ marginTop: '20px', padding: '15px', border: '1px solid #10b981', borderRadius: '8px', background: '#ecfdf5' }}>
                                    <h3 style={{ color: '#065f46', marginTop: 0 }}>✓ Anonymization Successful</h3>
                                    <p style={{ margin: '5px 0', fontSize: '0.9rem', color: '#065f46' }}>
                                        <strong>ML Processing Summary:</strong>
                                    </p>
                                    <ul style={{ fontSize: '0.85rem', color: '#065f46', paddingLeft: '20px' }}>
                                        <li>✓ OCR Detection ({anonResult.phiCount > 0 ? 'Text found' : 'No text'})</li>
                                        <li>✓ PHI Detection ({anonResult.phiCount} lines detected)</li>
                                        <li>✓ Fracture-Aware Redaction ({anonResult.pixelatedCount || 0} pixelated, {(anonResult.phiCount || 0) - (anonResult.pixelatedCount || 0)} blacked out)</li>
                                        <li>✓ Metadata Scrubbing ({anonResult.metadataScrubbed ? 'Yes' : 'No'})</li>
                                        <li>✓ Medical Region Protection ({anonResult.protectedFractureRegions} protected)</li>
                                    </ul>
                                    <div style={{ marginTop: '15px', textAlign: 'center' }}>
                                        <p style={{ fontSize: '0.85rem', color: '#065f46', fontWeight: 600 }}>ANONYMIZED MEDICAL IMAGE</p>
                                        <img src={anonResult.image} alt="Anonymized Result" style={{ maxWidth: '100%', borderRadius: '4px', border: '1px solid #a7f3d0' }} />
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* ══════════════════════════════════════════════════════════════════ */}
                        {/* ── NEW: Interactive 3-Panel Anonymization Demonstration ── */}
                        {/* ══════════════════════════════════════════════════════════════════ */}
                        <div style={{
                            marginTop: '36px',
                            borderTop: '2px solid #6366f1',
                            paddingTop: '28px'
                        }}>
                            {/* Header */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
                                <span style={{ fontSize: '1.4rem' }}>🔬</span>
                                <div>
                                    <h2 style={{ margin: 0, fontSize: '1.15rem', color: '#1e1b4b', fontWeight: 800 }}>
                                        Interactive Anonymization Demo
                                    </h2>
                                    <p style={{ margin: 0, fontSize: '0.8rem', color: '#6366f1', fontWeight: 600 }}>
                                        SUPMS-Fair Research Pipeline · Fracture X-Ray Dataset
                                    </p>
                                </div>
                                <span style={{
                                    marginLeft: 'auto', background: '#ede9fe', color: '#6366f1',
                                    fontSize: '0.7rem', fontWeight: 700, padding: '3px 10px',
                                    borderRadius: '99px', letterSpacing: '0.05em'
                                }}>LIVE PIPELINE</span>
                            </div>
                            <p style={{ fontSize: '0.82rem', color: '#64748b', marginBottom: '20px', lineHeight: 1.6 }}>
                                Select a fracture X-ray from the benchmark dataset or upload your own.
                                The system will inject <strong>synthetic demo PHI</strong> (no real patient data),
                                run OCR detection, and anonymize — showing all three stages side-by-side.
                            </p>

                            {/* Demo form */}
                            <form onSubmit={e => { fetchDemoImages(); submitDemo(e); }} style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'flex-end', marginBottom: '20px' }}>
                                <div style={{ flex: '1 1 240px' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '5px' }}>
                                        <label style={{ fontSize: '0.78rem', fontWeight: 700, color: '#374151' }}>
                                            📂 Select Dataset Image
                                        </label>
                                        <button
                                            type="button"
                                            onClick={fetchDemoImages}
                                            style={{
                                                background: 'none', border: 'none', color: '#6366f1',
                                                fontSize: '0.74rem', fontWeight: 600, cursor: 'pointer', padding: 0
                                            }}
                                            title="Click to refresh image list"
                                        >
                                            🔄 {demoDatasetImages.length > 0 ? `${demoDatasetImages.length} images` : 'Reload'}
                                        </button>
                                    </div>
                                    <select
                                        id="demo-dataset-image-select"
                                        value={demoSelectedImage}
                                        onChange={e => { setDemoSelectedImage(e.target.value); setDemoUploadFile(null); }}
                                        onFocus={fetchDemoImages}
                                        onMouseDown={fetchDemoImages}
                                        onClick={fetchDemoImages}
                                        style={{ width: '100%', padding: '8px 10px', borderRadius: '8px', border: '1px solid #c7d2fe', fontSize: '0.85rem', background: '#f5f3ff' }}
                                    >
                                        <option value="">
                                            {demoDatasetImages.length > 0
                                                ? `— choose from ${demoDatasetImages.length}-image dataset —`
                                                : '— loading 100 images (click to load) —'}
                                        </option>
                                        {demoDatasetImages.map(img => (
                                            <option key={img} value={img}>{img}</option>
                                        ))}
                                    </select>
                                </div>
                                <div style={{ flex: '0 0 auto', color: '#94a3b8', fontWeight: 700, paddingBottom: '8px' }}>OR</div>
                                <div style={{ flex: '1 1 200px' }}>
                                    <label style={{ fontSize: '0.78rem', fontWeight: 700, color: '#374151', display: 'block', marginBottom: '5px' }}>
                                        ⬆️ Upload X-ray
                                    </label>
                                    <input
                                        id="demo-upload-input"
                                        type="file"
                                        accept=".jpg,.jpeg,.png"
                                        onChange={e => { setDemoUploadFile(e.target.files[0]); setDemoSelectedImage(''); }}
                                        style={{ padding: '6px 8px', border: '1px solid #c7d2fe', borderRadius: '8px', width: '100%', background: '#fff', fontSize: '0.82rem' }}
                                    />
                                </div>
                                <button
                                    id="demo-process-btn"
                                    type="submit"
                                    disabled={demoRunning}
                                    style={{
                                        flex: '0 0 auto',
                                        background: demoRunning ? '#a5b4fc' : 'linear-gradient(135deg,#6366f1,#4f46e5)',
                                        color: 'white', border: 'none', borderRadius: '10px',
                                        padding: '10px 22px', fontWeight: 700, fontSize: '0.9rem',
                                        cursor: demoRunning ? 'not-allowed' : 'pointer',
                                        boxShadow: demoRunning ? 'none' : '0 4px 14px rgba(99,102,241,0.35)',
                                        transition: 'all 0.2s'
                                    }}
                                >
                                    {demoRunning ? '⏳ ' + demoStatus : '▶ Process & Anonymize'}
                                </button>
                            </form>

                            {demoError && (
                                <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: '8px', padding: '12px 16px', color: '#b91c1c', fontSize: '0.85rem', marginBottom: '16px' }}>
                                    ⚠️ {demoError}
                                </div>
                            )}

                            {/* 3-Panel Result */}
                            {demoResult && (() => {
                                const m = demoResult.metrics || {};
                                // Bug 3 fix: show which source was actually processed
                                const src = demoResult.imageSource || 'unknown';
                                const panelStyle = {
                                    flex: '1 1 220px', minWidth: 0,
                                    background: '#fff', borderRadius: '12px',
                                    boxShadow: '0 2px 12px rgba(0,0,0,0.08)',
                                    overflow: 'hidden', border: '1px solid #e2e8f0'
                                };
                                const labelStyle = (bg, fg) => ({
                                    background: bg, color: fg,
                                    padding: '8px 14px', fontSize: '0.72rem',
                                    fontWeight: 800, letterSpacing: '0.07em',
                                    textAlign: 'center'
                                });
                                // Bug 2 fix: panel 3 caption is conditional
                                const allAnonymized = m.anonymizedPHI >= m.totalPHI && m.totalPHI > 0;
                                const missedCount   = m.totalPHI - (m.anonymizedPHI || 0);
                                return (
                                    <>
                                        {/* Bug 3: source banner */}
                                        <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: '8px', padding: '7px 14px', marginBottom: '14px', fontSize: '0.75rem', color: '#0369a1', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                            <span>🖼️</span>
                                            <span><strong>Processed:</strong> {src}</span>
                                        </div>

                                        {/* Panels */}
                                        <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', marginBottom: '20px' }}>
                                            {/* Panel 1: Original */}
                                            <div style={panelStyle}>
                                                <div style={labelStyle('#0f172a','#f8fafc')}>ORIGINAL</div>
                                                <img
                                                    src={`data:image/jpeg;base64,${demoResult.originalImage}`}
                                                    alt="Original X-ray"
                                                    style={{ width: '100%', display: 'block', objectFit: 'contain', maxHeight: '280px', background: '#000' }}
                                                />
                                                <div style={{ padding: '8px 12px', fontSize: '0.72rem', color: '#64748b', textAlign: 'center' }}>
                                                    Unmodified fracture radiograph
                                                </div>
                                            </div>

                                            {/* Panel 2: Contaminated */}
                                            <div style={panelStyle}>
                                                <div style={labelStyle('#b45309','#fffbeb')}>CONTAMINATED — SYNTHETIC PHI</div>
                                                <img
                                                    src={`data:image/jpeg;base64,${demoResult.contaminatedImage}`}
                                                    alt="Contaminated with synthetic PHI"
                                                    style={{ width: '100%', display: 'block', objectFit: 'contain', maxHeight: '280px', background: '#000' }}
                                                />
                                                <div style={{ padding: '8px 12px', fontSize: '0.72rem', color: '#92400e', textAlign: 'center', background: '#fffbeb' }}>
                                                    ⚠️ Synthetic PHI injected for evaluation ({m.totalPHI} fields)
                                                </div>
                                            </div>

                                            {/* Panel 3: Anonymized — Bug 2 fix: conditional caption */}
                                            <div style={panelStyle}>
                                                <div style={labelStyle('#065f46','#ecfdf5')}>ANONYMIZED</div>
                                                <img
                                                    src={`data:image/jpeg;base64,${demoResult.anonymizedImage}`}
                                                    alt="Anonymized X-ray"
                                                    style={{ width: '100%', display: 'block', objectFit: 'contain', maxHeight: '280px', background: '#000' }}
                                                />
                                                {allAnonymized ? (
                                                    <div style={{ padding: '8px 12px', fontSize: '0.72rem', color: '#065f46', textAlign: 'center', background: '#ecfdf5' }}>
                                                        ✓ All PHI redacted — anatomy preserved
                                                    </div>
                                                ) : (
                                                    <div style={{ padding: '8px 12px', fontSize: '0.72rem', color: '#b91c1c', textAlign: 'center', background: '#fef2f2', border: '1px solid #fca5a5' }}>
                                                        ⚠️ {missedCount} field{missedCount !== 1 ? 's' : ''} not anonymized — manual review required
                                                    </div>
                                                )}
                                            </div>
                                        </div>

                                        {/* Synthetic PHI legend */}
                                        {demoResult.syntheticPHI && demoResult.syntheticPHI.length > 0 && (
                                            <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: '10px', padding: '12px 16px', marginBottom: '16px' }}>
                                                <p style={{ margin: '0 0 8px', fontSize: '0.78rem', fontWeight: 700, color: '#9a3412' }}>🏷️ Synthetic PHI Injected (ground truth — all fake):</p>
                                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                                                    {demoResult.syntheticPHI.map((f, i) => (
                                                        <span key={i} style={{ background: '#fed7aa', color: '#7c2d12', padding: '3px 10px', borderRadius: '99px', fontSize: '0.72rem', fontWeight: 600 }}>
                                                            {f.type}: {f.text}
                                                        </span>
                                                    ))}
                                                </div>
                                            </div>
                                        )}

                                        {/* Metrics */}
                                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '10px', marginBottom: '8px' }}>
                                            {[
                                                { label: 'PHI Fields Injected', val: m.totalPHI, icon: '🔢', color: '#b45309' },
                                                { label: 'PHI Detected',         val: m.detectedPHI, icon: '🔍', color: '#1d4ed8' },
                                                { label: 'PHI Anonymized',       val: m.anonymizedPHI, icon: '🛡️', color: '#065f46' },
                                                { label: 'Detection Rate',       val: m.detectionRate + '%', icon: '📊', color: '#1d4ed8' },
                                                { label: 'Anon. Rate',           val: m.anonymizationRate + '%', icon: '✅', color: '#065f46' },
                                                { label: 'Processing Time',      val: m.processingTimeMs + ' ms', icon: '⏱️', color: '#4f46e5' },
                                            ].map((s, i) => (
                                                <div key={i} style={{
                                                    background: '#f8fafc', borderRadius: '10px',
                                                    padding: '12px 14px', textAlign: 'center',
                                                    border: '1px solid #e2e8f0'
                                                }}>
                                                    <div style={{ fontSize: '1.3rem' }}>{s.icon}</div>
                                                    <div style={{ fontSize: '1.1rem', fontWeight: 800, color: s.color }}>{s.val}</div>
                                                    <div style={{ fontSize: '0.68rem', color: '#64748b', fontWeight: 600, marginTop: '2px' }}>{s.label}</div>
                                                </div>
                                            ))}
                                        </div>

                                        <p style={{ fontSize: '0.7rem', color: '#94a3b8', textAlign: 'center', margin: '4px 0 0' }}>
                                            All PHI shown above is synthetically generated. No real patient data was used.
                                        </p>
                                    </>
                                );
                            })()}
                        </div>
                    </div>
                </main>
            </div>
        );
    }


    // ── DOCTOR layout — professional portal ────────────────────────────────
    const initials = user.username ? user.username.slice(0, 2).toUpperCase() : 'DR';

    return (
        <div className="doctor-portal">
            {/* ── Top Navigation Bar ── */}
            <nav className="doctor-topbar">
                <div className="doctor-topbar__brand">
                    <div className="doctor-topbar__logo-icon">🏥</div>
                    <span className="doctor-topbar__logo-text">
                        SUPMS<span className="doctor-topbar__logo-dot">.</span>
                    </span>
                </div>
                <div className="doctor-topbar__actions">
                    <div className="doctor-topbar__user">
                        <div className="doctor-topbar__user-avatar">{initials}</div>
                        Dr. {user.username}
                    </div>
                    <button onClick={onLogout} className="logout-btn">Sign Out</button>
                </div>
            </nav>

            {/* ── Main Content ── */}
            <main className="doctor-main">
                <p className="doctor-section-title">Doctor Dashboard</p>
                <p className="doctor-section-sub">
                    Good day, Dr. {user.username}. Here's your practice overview.
                </p>

                {/* ── Quick Stats Row ── */}
                {dashboardStats && (
                    <div className="doctor-stats-row">
                        <div className="doctor-stat-card">
                            <div className="doctor-stat-card__icon doctor-stat-card__icon--blue">👥</div>
                            <div>
                                <div className="doctor-stat-card__val">{dashboardStats.totalPatients}</div>
                                <div className="doctor-stat-card__label">Total Patients</div>
                            </div>
                        </div>
                        <div className="doctor-stat-card">
                            <div className="doctor-stat-card__icon doctor-stat-card__icon--green">📋</div>
                            <div>
                                <div className="doctor-stat-card__val">{dashboardStats.totalVisits}</div>
                                <div className="doctor-stat-card__label">Total Visits</div>
                            </div>
                        </div>
                        <div className="doctor-stat-card">
                            <div className="doctor-stat-card__icon doctor-stat-card__icon--amber">⏳</div>
                            <div>
                                <div className="doctor-stat-card__val">
                                    {dashboardStats.recentVisits ? dashboardStats.recentVisits.length : '—'}
                                </div>
                                <div className="doctor-stat-card__label">Recent Visits</div>
                            </div>
                        </div>
                        <div className="doctor-stat-card">
                            <div className="doctor-stat-card__icon doctor-stat-card__icon--rose">💊</div>
                            <div>
                                <div className="doctor-stat-card__val">
                                    {dashboardStats.commonDiagnoses ? dashboardStats.commonDiagnoses.length : '—'}
                                </div>
                                <div className="doctor-stat-card__label">Diagnoses Tracked</div>
                            </div>
                        </div>
                    </div>
                )}

                {/* ── Appointment Management Module ── */}
                <DoctorAppointments user={user} />

                <hr className="doctor-divider" />

                {/* ── Dashboard Stats Detail ── */}
                {dashboardStats && (
                    <div className="dashboard-stats">
                        <h2>Practice Overview</h2>
                        <p><strong>Total Patients:</strong> {dashboardStats.totalPatients}</p>
                        <p><strong>Total Visits:</strong> {dashboardStats.totalVisits}</p>
                        {dashboardStats.recentVisits && dashboardStats.recentVisits.length > 0 && (
                            <>
                                <h3>Recent Visits</h3>
                                <ul>
                                    {dashboardStats.recentVisits.map(v => (
                                        <li key={v.id}>
                                            {v.patient_name} — {v.diagnosis}{' '}
                                            <span style={{ color: '#94a3b8', fontSize: '0.78rem' }}>
                                                ({new Date(v.visit_date).toLocaleDateString()})
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            </>
                        )}
                        {dashboardStats.commonDiagnoses && dashboardStats.commonDiagnoses.length > 0 && (
                            <>
                                <h3>Common Diagnoses</h3>
                                <ul>
                                    {dashboardStats.commonDiagnoses.map(d => (
                                        <li key={d.diagnosis}>{d.diagnosis} ({d.count} cases)</li>
                                    ))}
                                </ul>
                            </>
                        )}
                    </div>
                )}

                <hr className="doctor-divider" />

                {/* ── Patient Management ── */}
                <div className="all-appointments-section" style={{ marginTop: 0 }}>
                    <div className="section-header">
                        <h3>Patient Management</h3>
                    </div>

                    <form onSubmit={handleSearch} className="search-form">
                        <input
                            type="text"
                            placeholder="🔍  Search patients by name or ID…"
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                        />
                        <button type="submit" disabled={searching}>
                            {searching ? 'Searching…' : 'Search'}
                        </button>
                    </form>

                    {searchResults.length > 0 && (
                        <div className="search-results">
                            <h3>Search Results</h3>
                            {searchResults.map(p => (
                                <div key={p.id} className="patient-card" onClick={() => setProfileId(p.id)}>
                                    {p.name} · Age {p.age}
                                </div>
                            ))}
                        </div>
                    )}

                    <div className="patients-list" style={{ marginBottom: 0 }}>
                        {patients.map(p => (
                            <div key={p.id} className="patient-card" onClick={() => setProfileId(p.id)}>
                                {p.name} · Age {p.age}
                            </div>
                        ))}
                    </div>
                </div>

                {/* ── Add Visit Form ── */}
                <div className="add-visit">
                    <h2>Add New Visit</h2>
                    <form onSubmit={submitVisit} className="visit-form">
                        <select value={patientId} onChange={e => setPatientId(e.target.value)} required>
                            <option value="">Select Patient</option>
                            {patients.map(p => (
                                <option key={p.id} value={p.id}>{p.name}</option>
                            ))}
                        </select>
                        <input type="text" placeholder="Diagnosis" value={diagnosis} onChange={e => setDiagnosis(e.target.value)} required />
                        <input type="text" placeholder="Treatment" value={treatment} onChange={e => setTreatment(e.target.value)} required />
                        <input type="text" placeholder="Prescription" value={prescription} onChange={e => setPrescription(e.target.value)} />
                        
                        <div className="file-upload-group" style={{ display: 'flex', gap: '10px', alignItems: 'center', margin: '10px 0' }}>
                            <div style={{ flex: 1 }}>
                                <label style={{ fontSize: '0.85rem', color: '#64748b', marginBottom: '4px', display: 'block', fontWeight: 600 }}>Upload Report (PDF/Image)</label>
                                <input 
                                    type="file" 
                                    onChange={e => setReportFile(e.target.files[0])} 
                                    accept=".pdf,.png,.jpg,.jpeg"
                                    style={{ padding: '8px', border: '1px solid #e2e8f0', borderRadius: '8px', width: '100%', background: '#fff' }}
                                />
                            </div>
                            <span style={{ color: '#94a3b8', fontSize: '0.85rem', fontWeight: 600 }}>OR</span>
                            <div style={{ flex: 1 }}>
                                <label style={{ fontSize: '0.85rem', color: '#64748b', marginBottom: '4px', display: 'block', fontWeight: 600 }}>Report Link</label>
                                <input 
                                    type="text" 
                                    placeholder="External URL" 
                                    value={report} 
                                    onChange={e => setReport(e.target.value)} 
                                    style={{ margin: 0 }}
                                />
                            </div>
                        </div>

                        <select value={progress} onChange={e => setProgress(e.target.value)}>
                            <option value="ongoing">Ongoing</option>
                            <option value="completed">Completed</option>
                        </select>
                        <textarea placeholder="Internal notes or comments…" value={notes} onChange={e => setNotes(e.target.value)} rows="3" />
                        <button type="submit">Add Visit Record</button>
                    </form>
                </div>

                {/* ── DOCTOR VIEW: Anonymized Images Only ── */}
                <div className="add-visit" style={{ marginTop: '30px', borderTop: '2px solid #e2e8f0', paddingTop: '20px' }}>
                    <h2>Available Medical Images</h2>
                    <p style={{ fontSize: '0.85rem', color: '#64748b', marginBottom: '15px' }}>
                        All available medical images have been strictly anonymized and protected.
                    </p>
                    {patientId ? (
                        <div style={{ padding: '15px', border: '1px solid #10b981', borderRadius: '8px', background: '#ecfdf5' }}>
                            <p style={{ color: '#065f46', fontSize: '0.9rem' }}>Fetching anonymized records for patient...</p>
                            {anonResult && anonResult.status === 'SUCCESS' ? (
                                <div>
                                    <img src={anonResult.image || '/api/images/anonymized/' + anonResult.anonymizationId} style={{ maxWidth: '100%', borderRadius: '4px' }} alt="Anonymized Medical Scan"/>
                                    <br/>
                                    <a href={anonResult.image || '/api/images/anonymized/' + anonResult.anonymizationId} download className="logout-btn" style={{marginTop: '10px', display: 'inline-block'}}>Download Secure Data</a>
                                </div>
                            ) : (
                                <p style={{ color: '#065f46', fontStyle: 'italic', fontSize: '0.85rem' }}>No anonymized data found for this patient.</p>
                            )}
                        </div>
                    ) : (
                        <p style={{ fontSize: '0.85rem', color: '#64748b', fontStyle: 'italic' }}>Please select a patient above to view their medical records.</p>
                    )}
                </div>

                {/* ── Insecure Diagnosis Submission Form (Vulnerability Demo) ── */}
                <div className="add-visit diagnosis-demo" style={{ marginTop: '30px', borderTop: '2px dashed #f87171', paddingTop: '20px' }}>
                    <h2 style={{ color: '#ef4444' }}>⚠️ Submit Diagnosis (Insecure)</h2>
                    <p style={{ fontSize: '0.85rem', color: '#64748b', marginBottom: '15px' }}>
                        This form demonstrates a lack of data integrity protection. Doctors can submit diagnoses for ANY patient ID.
                    </p>
                    <form onSubmit={submitDiagnosis} className="visit-form">
                        <select 
                            value={diagPatientId} 
                            onChange={e => setDiagPatientId(e.target.value)} 
                            required
                            style={{ border: '1px solid #f87171' }}
                        >
                            <option value="">Select Target Patient</option>
                            {patients.map(p => (
                                <option key={p.id} value={p.id}>{p.name} (ID: {p.id})</option>
                            ))}
                        </select>
                        <input 
                            type="text" 
                            placeholder="Enter Diagnosis (e.g., Seasonal Flu)" 
                            value={diagDiagnosis} 
                            onChange={e => setDiagDiagnosis(e.target.value)} 
                            required 
                            style={{ border: '1px solid #f87171' }}
                        />
                        <button 
                            type="submit" 
                            disabled={diagSubmitting}
                            style={{ background: '#ef4444', color: 'white' }}
                        >
                            {diagSubmitting ? 'Submitting...' : 'Submit Diagnosis →'}
                        </button>
                    </form>
                    <p style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: '10px' }}>
                        * Demo instruction: Intercept this request in Burp Suite and modify the diagnosis before it reaches the server.
                    </p>
                </div>
            </main>

        </div>
    );
}

export default App;