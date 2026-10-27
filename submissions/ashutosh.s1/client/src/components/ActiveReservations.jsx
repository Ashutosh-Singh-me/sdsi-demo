import ReservationRow from './ReservationRow.jsx';

export default function ActiveReservations({ reservations, onConfirm, onCancel }) {
  const activeReservations = reservations.filter((r) => r.status === 'active');

  return (
    <section className="panel">
      <h2>My Reservations</h2>
      {activeReservations.length === 0 ? (
        <p className="empty">No active reservations.</p>
      ) : (
        <div className="reservation-list">
          {activeReservations.map((r) => (
            <ReservationRow
              key={r.id}
              reservation={r}
              onConfirm={onConfirm}
              onCancel={onCancel}
            />
          ))}
        </div>
      )}

      <details>
        <summary>History ({reservations.filter((r) => r.status !== 'active').length})</summary>
        {reservations.filter((r) => r.status !== 'active').map((r) => (
          <div key={r.id} className={`reservation-history status-${r.status}`}>
            <span>{r.product_name || r.sku}</span>
            <span>×{r.quantity}</span>
            <span className="tag">{r.status}</span>
            <span className="muted">{new Date(r.created_at).toLocaleTimeString()}</span>
          </div>
        ))}
      </details>
    </section>
  );
}