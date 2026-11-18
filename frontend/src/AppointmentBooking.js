import React, { useState, useEffect } from 'react';
import axios from 'axios';

function AppointmentBooking({ user }) {
    const [doctors, setDoctors] = useState([]);
    const [selectedDoctor, setSelectedDoctor] = useState('');
    const [appointmentDate, setAppointmentDate] = useState('');
    const [reason, setReason] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    const [myAppointments, setMyAppointments] = useState([]);

    useEffect(() => {
        fetchDoctors();
        fetchMyAppointments();
    }, []);

    const fetchDoctors = async () => {
        try {
            const res = await axios.get('/appointments/available-doctors');
            setDoctors(res.data);
        } catch (err) {
            console.error('Error fetching doctors:', err);
        }
    };

    const fetchMyAppointments = async () => {
        try {
            const res = await axios.get('/appointments/my-appointments');
            setMyAppointments(res.data);
        } catch (err) {
            console.error('Error fetching appointments:', err);
        }
    };

    const bookAppointment = async (e) => {
        e.preventDefault();
        setError('');
        setSuccess('');

        if (!selectedDoctor || !appointmentDate) {
            setError('Please select a doctor and date/time');
            return;
        }

        if (new Date(appointmentDate) < new Date()) {
            setError('Cannot book an appointment in the past');
            return;
        }

        setLoading(true);
        try {
            const res = await axios.post('/appointments/book', {
                doctor_id: selectedDoctor,
                appointment_date: appointmentDate,
                reason: reason
            });

            if (res.data.success) {
                setSuccess('Appointment booked successfully! Awaiting doctor approval.');
                setSelectedDoctor('');
                setAppointmentDate('');
                setReason('');
                fetchMyAppointments();
            }
        } catch (err) {
            setError(err.response?.data || 'Failed to book appointment');
        } finally {
            setLoading(false);
        }
    };

    const cancelAppointment = async (id) => {
        if (!window.confirm('Are you sure you want to cancel this appointment?')) return;
        try {
            await axios.delete(`/appointments/${id}/cancel`);
            setSuccess('Appointment cancelled');
            fetchMyAppointments();
        } catch (err) {
            setError('Failed to cancel appointment');
        }
    };

    const approvalConfig = {
        pending:  { bg: '#fff7ed', color: '#c2410c', border: '#fed7aa', text: '⏳ Pending Approval' },
        approved: { bg: '#f0fdf4', color: '#166534', border: '#bbf7d0', text: '✓ Approved' },
        rejected: { bg: '#fff1f2', color: '#be123c', border: '#fecdd3', text: '✗ Rejected' },
    };

    const statusConfig = {
        scheduled:  { bg: '#eff6ff', color: '#1d4ed8', border: '#bfdbfe', text: 'Scheduled' },
        completed:  { bg: '#f0fdf4', color: '#166534', border: '#bbf7d0', text: 'Completed' },
        cancelled:  { bg: '#f8fafc', color: '#64748b', border: '#e2e8f0', text: 'Cancelled' },
    };

    return (
        <div className="appt-booking">
            {/* ── Book Form ── */}
            <div className="appt-form-card">
                <div className="appt-form-card__header">
                    <div className="appt-form-card__icon">📅</div>
                    <div>
                        <div className="appt-form-card__title">Book an Appointment</div>
                        <div className="appt-form-card__sub">Schedule a visit with one of our doctors</div>
                    </div>
                </div>

                {error   && <div className="appt-msg appt-msg--error">⚠️ {error}</div>}
                {success && <div className="appt-msg appt-msg--success">✓ {success}</div>}

                <form onSubmit={bookAppointment} className="appt-form">
                    <div className="appt-form__row">
                        <div className="appt-form__group">
                            <label className="appt-form__label">Select Doctor</label>
                            <select
                                value={selectedDoctor}
                                onChange={(e) => setSelectedDoctor(e.target.value)}
                                required
                                className="appt-form__input"
                            >
                                <option value="">Choose a doctor…</option>
                                {doctors.map(doctor => (
                                    <option key={doctor.id} value={doctor.id}>
                                        Dr. {doctor.username}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className="appt-form__group">
                            <label className="appt-form__label">Date &amp; Time</label>
                            <input
                                type="datetime-local"
                                value={appointmentDate}
                                onChange={(e) => setAppointmentDate(e.target.value)}
                                min={new Date().toISOString().slice(0, 16)}
                                required
                                className="appt-form__input"
                            />
                        </div>
                    </div>
                    <div className="appt-form__group">
                        <label className="appt-form__label">Reason for Visit <span className="appt-optional">(Optional)</span></label>
                        <textarea
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            placeholder="Briefly describe your symptoms or reason for visit…"
                            rows="3"
                            className="appt-form__input"
                        />
                    </div>
                    <button type="submit" disabled={loading} className="appt-submit-btn">
                        {loading ? '⏳ Booking…' : '📅 Book Appointment'}
                    </button>
                </form>
            </div>

            {/* ── My Appointments ── */}
            <div className="appt-list-section">
                <h3 className="appt-list-title">My Appointments</h3>
                {myAppointments.length === 0 ? (
                    <div className="appt-empty">
                        <div className="appt-empty__icon">📭</div>
                        <p>No appointments booked yet. Schedule your first visit above!</p>
                    </div>
                ) : (
                    <div className="appt-cards">
                        {myAppointments.map(appt => {
                            const st  = statusConfig[appt.status]   || statusConfig.scheduled;
                            const ap  = approvalConfig[appt.approval_status || 'pending'] || approvalConfig.pending;

                            return (
                                <div key={appt.id} className="appt-card">
                                    <div className="appt-card__header">
                                        <div className="appt-card__doctor">
                                            <div className="appt-card__doctor-avatar">
                                                {appt.doctor_name ? appt.doctor_name.slice(0, 2).toUpperCase() : 'DR'}
                                            </div>
                                            <div>
                                                <div className="appt-card__doctor-name">Dr. {appt.doctor_name}</div>
                                                <div className="appt-card__date">
                                                    📅 {new Date(appt.appointment_date).toLocaleString()}
                                                </div>
                                            </div>
                                        </div>
                                        <div className="appt-card__badges">
                                            <span
                                                className="appt-badge"
                                                style={{ background: st.bg, color: st.color, borderColor: st.border }}
                                            >
                                                {st.text}
                                            </span>
                                            <span
                                                className="appt-badge"
                                                style={{ background: ap.bg, color: ap.color, borderColor: ap.border }}
                                            >
                                                {ap.text}
                                            </span>
                                        </div>
                                    </div>
                                    <div className="appt-card__body">
                                        {appt.reason && (
                                            <p className="appt-card__row">
                                                <span className="appt-card__key">Reason</span>
                                                <span>{appt.reason}</span>
                                            </p>
                                        )}
                                        <p className="appt-card__row">
                                            <span className="appt-card__key">Booked on</span>
                                            <span>{new Date(appt.created_at).toLocaleString()}</span>
                                        </p>
                                        {appt.notes && (
                                            <div className="appt-card__notes">
                                                <span className="appt-card__key">Doctor's Notes</span>
                                                <p>{appt.notes}</p>
                                            </div>
                                        )}
                                        <div className="appt-card__actions">
                                            {appt.approval_status === 'rejected' && (
                                                <button
                                                    className="appt-rebook-btn"
                                                    onClick={() => alert('This appointment was rejected. Please book a new one.')}
                                                >
                                                    🔄 Book New Appointment
                                                </button>
                                            )}
                                            {appt.status === 'scheduled' && appt.approval_status !== 'rejected' && (
                                                <button
                                                    className="appt-cancel-btn"
                                                    onClick={() => cancelAppointment(appt.id)}
                                                >
                                                    ✕ Cancel
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}

export default AppointmentBooking;
