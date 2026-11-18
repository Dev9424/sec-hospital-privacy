import React, { useState, useEffect } from 'react';
import axios from 'axios';
import AppointmentBooking from './AppointmentBooking';
import Notifications from './Notifications';

function PatientDashboard({ user, onLogout }) {
    const [activeTab, setActiveTab] = useState('dashboard');
    const [profile, setProfile] = useState(null);
    const [medicalHistory, setMedicalHistory] = useState([]);
    const [reports, setReports] = useState([]);
    const [dashboardStats, setDashboardStats] = useState(null);
    const [loading, setLoading] = useState(true);
    const [editMode, setEditMode] = useState(false);
    const [profileData, setProfileData] = useState({
        email: '',
        phone: '',
        address: '',
        date_of_birth: '',
        gender: 'male',
        blood_group: '',
        emergency_contact: ''
    });

    useEffect(() => {
        fetchAllData();
    }, []);

    const fetchAllData = async () => {
        setLoading(true);
        try {
            const dashRes = await axios.get('/patient/dashboard');
            setDashboardStats(dashRes.data);

            const historyRes = await axios.get('/patient/medical-history');
            setMedicalHistory(historyRes.data);

            const reportsRes = await axios.get('/patient/reports');
            setReports(reportsRes.data);

            try {
                const profileRes = await axios.get('/patient/profile');
                setProfile(profileRes.data);
                setProfileData({
                    email: profileRes.data.email || '',
                    phone: profileRes.data.phone || '',
                    address: profileRes.data.address || '',
                    date_of_birth: profileRes.data.date_of_birth || '',
                    gender: profileRes.data.gender || 'male',
                    blood_group: profileRes.data.blood_group || '',
                    emergency_contact: profileRes.data.emergency_contact || ''
                });
            } catch (err) {
                console.log('Profile not found, will create on save');
            }
        } catch (err) {
            console.log('Error fetching data:', err);
        }
        setLoading(false);
    };

    const handleProfileChange = (e) => {
        setProfileData({ ...profileData, [e.target.name]: e.target.value });
    };

    const saveProfile = async (e) => {
        e.preventDefault();
        try {
            await axios.put('/patient/profile', profileData);
            alert('Profile updated successfully!');
            setEditMode(false);
            fetchAllData();
        } catch (err) {
            alert('Error updating profile');
        }
    };

    /* ── Tab: Dashboard ── */
    const renderDashboard = () => {
        if (!dashboardStats) return <p className="pd-loading">Loading…</p>;

        return (
            <div className="pd-dashboard">
                <div className="pd-stats-row">
                    <div className="pd-stat-card pd-stat-card--blue">
                        <div className="pd-stat-card__icon">🏥</div>
                        <div>
                            <div className="pd-stat-card__val">{dashboardStats.totalVisits}</div>
                            <div className="pd-stat-card__label">Total Visits</div>
                        </div>
                    </div>
                    <div className="pd-stat-card pd-stat-card--amber">
                        <div className="pd-stat-card__icon">💊</div>
                        <div>
                            <div className="pd-stat-card__val">{dashboardStats.ongoingTreatments}</div>
                            <div className="pd-stat-card__label">Ongoing Treatments</div>
                        </div>
                    </div>
                    <div className="pd-stat-card pd-stat-card--green">
                        <div className="pd-stat-card__icon">📋</div>
                        <div>
                            <div className="pd-stat-card__val">{medicalHistory.length}</div>
                            <div className="pd-stat-card__label">Medical Records</div>
                        </div>
                    </div>
                    <div className="pd-stat-card pd-stat-card--rose">
                        <div className="pd-stat-card__icon">📄</div>
                        <div>
                            <div className="pd-stat-card__val">{reports.length}</div>
                            <div className="pd-stat-card__label">Reports</div>
                        </div>
                    </div>
                </div>

                {/* Recent Visits */}
                <div className="pd-section-card">
                    <div className="pd-section-card__header">
                        <span className="pd-section-card__title">🕐 Recent Visits</span>
                    </div>
                    {dashboardStats.recentVisits.length === 0 ? (
                        <p className="pd-empty">No visits yet.</p>
                    ) : (
                        <div className="pd-timeline">
                            {dashboardStats.recentVisits.map((visit) => (
                                <div key={visit.id} className={`pd-timeline-item pd-timeline-item--${visit.progress}`}>
                                    <div className="pd-timeline-dot"></div>
                                    <div className="pd-timeline-content">
                                        <div className="pd-timeline-top">
                                            <span className="pd-timeline-diagnosis">{visit.diagnosis}</span>
                                            <span className={`pd-progress-badge pd-progress-badge--${visit.progress}`}>
                                                {visit.progress === 'completed' ? '✓ Completed' : '⟳ Ongoing'}
                                            </span>
                                        </div>
                                        <div className="pd-timeline-meta">
                                            <span>📅 {new Date(visit.visit_date).toLocaleDateString()}</span>
                                            <span>👨‍⚕️ {visit.doctor_name}</span>
                                        </div>
                                        <p className="pd-timeline-treatment">
                                            <strong>Treatment:</strong> {visit.treatment}
                                        </p>
                                        {visit.prescription && (
                                            <p className="pd-timeline-prescription">
                                                💊 {visit.prescription}
                                            </p>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Latest Prescription */}
                {dashboardStats.latestPrescription && (
                    <div className="pd-prescription-card">
                        <div className="pd-prescription-card__icon">💊</div>
                        <div>
                            <div className="pd-prescription-card__label">Latest Prescription</div>
                            <div className="pd-prescription-card__date">
                                {new Date(dashboardStats.latestPrescription.visit_date).toLocaleDateString()}
                            </div>
                            <div className="pd-prescription-card__text">
                                {dashboardStats.latestPrescription.prescription}
                            </div>
                        </div>
                    </div>
                )}
            </div>
        );
    };

    /* ── Tab: Medical History ── */
    const renderMedicalHistory = () => (
        <div className="pd-section">
            <h2 className="pd-section__title">Complete Medical History</h2>
            {medicalHistory.length === 0 ? (
                <p className="pd-empty">No medical records available.</p>
            ) : (
                <div className="pd-history-list">
                    {medicalHistory.map((visit) => (
                        <div key={visit.id} className={`pd-history-card ${visit.tampered ? 'pd-history-card--tampered' : ''}`}>
                             <div className="pd-history-card__header">
                                 <div>
                                     <span className="pd-history-card__diagnosis">
                                         {visit.diagnosis}
                                         {visit.tampered && <span className="pd-tamper-warn"> ⚠️ DATA TAMPERED!</span>}
                                     </span>
                                    <span className="pd-history-card__date">
                                        {new Date(visit.visit_date).toLocaleDateString()}
                                    </span>
                                </div>
                                <span className={`pd-progress-badge pd-progress-badge--${visit.progress}`}>
                                    {visit.progress === 'completed' ? '✓ Completed' : '⟳ Ongoing'}
                                </span>
                            </div>
                            <div className="pd-history-card__body">
                                <div className="pd-history-card__row">
                                    <span className="pd-history-card__key">Doctor</span>
                                    <span className="pd-history-card__val">{visit.doctor_name}</span>
                                </div>
                                <div className="pd-history-card__row">
                                    <span className="pd-history-card__key">Treatment</span>
                                    <span className="pd-history-card__val">{visit.treatment}</span>
                                </div>
                                {visit.prescription && (
                                    <div className="pd-history-card__row">
                                        <span className="pd-history-card__key">Prescription</span>
                                        <span className="pd-history-card__val">{visit.prescription}</span>
                                    </div>
                                )}
                                {visit.report && (
                                    <div className="pd-history-card__row">
                                        <span className="pd-history-card__key">Report</span>
                                        <span className="pd-history-card__val">{visit.report}</span>
                                    </div>
                                )}
                                {visit.notes && (
                                    <div className="pd-history-card__row">
                                        <span className="pd-history-card__key">Notes</span>
                                        <span className="pd-history-card__val pd-history-card__notes">{visit.notes}</span>
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );

    /* ── Tab: Reports ── */
    const renderReports = () => (
        <div className="pd-section">
            <h2 className="pd-section__title">Medical Reports</h2>
            {reports.length === 0 ? (
                <p className="pd-empty">No reports available.</p>
            ) : (
                <div className="pd-reports-grid">
                    {reports.map((report) => (
                        <div key={report.id} className="pd-report-card">
                            <div className="pd-report-card__icon">📄</div>
                            <div className="pd-report-card__diagnosis">{report.diagnosis}</div>
                            <div className="pd-report-card__meta">
                                <span>📅 {new Date(report.visit_date).toLocaleDateString()}</span>
                                <span>👨‍⚕️ {report.doctor_name}</span>
                            </div>
                            <p className="pd-report-card__text">{report.report}</p>
                            <button
                                className="pd-report-card__btn"
                                onClick={() => window.open(report.report, '_blank')}
                            >
                                View Report ↗
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );

    /* ── Tab: Profile ── */
    const renderProfile = () => (
        <div className="pd-section">
            <h2 className="pd-section__title">My Profile</h2>
            {!editMode ? (
                <div className="pd-profile-view">
                    <div className="pd-profile-avatar">
                        {user.username.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="pd-profile-name">{user.username}</div>
                    <div className="pd-profile-role">Patient</div>

                    <div className="pd-profile-grid">
                        {[
                            { icon: '✉️', label: 'Email', val: profile?.email },
                            { icon: '📞', label: 'Phone', val: profile?.phone },
                            { icon: '🎂', label: 'Date of Birth', val: profile?.date_of_birth },
                            { icon: '⚧', label: 'Gender', val: profile?.gender },
                            { icon: '🩸', label: 'Blood Group', val: profile?.blood_group },
                            { icon: '🚨', label: 'Emergency Contact', val: profile?.emergency_contact },
                            { icon: '📍', label: 'Address', val: profile?.address },
                        ].map(({ icon, label, val }) => (
                            <div key={label} className="pd-profile-field">
                                <span className="pd-profile-field__icon">{icon}</span>
                                <div>
                                    <div className="pd-profile-field__label">{label}</div>
                                    <div className="pd-profile-field__val">{val || 'Not provided'}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                    <button className="pd-edit-btn" onClick={() => setEditMode(true)}>
                        ✏️ Edit Profile
                    </button>
                </div>
            ) : (
                <form onSubmit={saveProfile} className="pd-profile-form">
                    <h3 className="pd-profile-form__title">Edit Profile Information</h3>
                    <div className="pd-form-grid">
                        <div className="pd-form-group">
                            <label>Email</label>
                            <input type="email" name="email" placeholder="Email address" value={profileData.email} onChange={handleProfileChange} />
                        </div>
                        <div className="pd-form-group">
                            <label>Phone</label>
                            <input type="tel" name="phone" placeholder="Phone number" value={profileData.phone} onChange={handleProfileChange} />
                        </div>
                        <div className="pd-form-group">
                            <label>Date of Birth</label>
                            <input type="date" name="date_of_birth" value={profileData.date_of_birth} onChange={handleProfileChange} />
                        </div>
                        <div className="pd-form-group">
                            <label>Gender</label>
                            <select name="gender" value={profileData.gender} onChange={handleProfileChange}>
                                <option value="male">Male</option>
                                <option value="female">Female</option>
                                <option value="other">Other</option>
                            </select>
                        </div>
                        <div className="pd-form-group">
                            <label>Blood Group</label>
                            <input type="text" name="blood_group" placeholder="e.g. A+" value={profileData.blood_group} onChange={handleProfileChange} />
                        </div>
                        <div className="pd-form-group">
                            <label>Emergency Contact</label>
                            <input type="tel" name="emergency_contact" placeholder="Emergency contact number" value={profileData.emergency_contact} onChange={handleProfileChange} />
                        </div>
                    </div>
                    <div className="pd-form-group pd-form-group--full">
                        <label>Address</label>
                        <textarea name="address" placeholder="Full address" value={profileData.address} onChange={handleProfileChange} rows="3" />
                    </div>
                    <div className="pd-form-actions">
                        <button type="submit" className="pd-save-btn">💾 Save Changes</button>
                        <button type="button" className="pd-cancel-btn" onClick={() => setEditMode(false)}>Cancel</button>
                    </div>
                </form>
            )}
        </div>
    );

    if (loading) {
        return (
            <div className="pd-loading-screen">
                <div className="pd-loading-spinner"></div>
                <p>Loading your health data…</p>
            </div>
        );
    }

    const initials = user.username ? user.username.slice(0, 2).toUpperCase() : 'PT';

    const tabs = [
        { id: 'dashboard',    label: '🏠 Overview' },
        { id: 'appointments', label: '📅 Appointments' },
        { id: 'history',      label: '🗂 History' },
        { id: 'reports',      label: '📄 Reports' },
        { id: 'profile',      label: '👤 Profile' },
    ];

    return (
        <div className="pd-portal">
            {/* ── Top Navigation Bar ── */}
            <nav className="pd-topbar">
                <div className="pd-topbar__brand">
                    <div className="pd-topbar__logo-icon">🏥</div>
                    <span className="pd-topbar__logo-text">
                        SUPMS<span className="pd-topbar__logo-dot">.</span>
                    </span>
                </div>
                <div className="pd-topbar__actions">
                    <div className="pd-topbar__user">
                        <div className="pd-topbar__avatar">{initials}</div>
                        {user.username}
                    </div>
                    <button onClick={onLogout} className="pd-topbar__logout">Sign Out</button>
                </div>
            </nav>

            {/* ── Tab Navigation ── */}
            <div className="pd-tab-bar">
                <div className="pd-tab-bar__inner">
                    {tabs.map(tab => (
                        <button
                            key={tab.id}
                            className={`pd-tab ${activeTab === tab.id ? 'pd-tab--active' : ''}`}
                            onClick={() => setActiveTab(tab.id)}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* ── Content ── */}
            <main className="pd-main">
                {activeTab === 'dashboard'    && renderDashboard()}
                {activeTab === 'appointments' && <AppointmentBooking user={user} />}
                {activeTab === 'history'      && renderMedicalHistory()}
                {activeTab === 'reports'      && renderReports()}
                {activeTab === 'profile'      && renderProfile()}
            </main>
        </div>
    );
}

export default PatientDashboard;
