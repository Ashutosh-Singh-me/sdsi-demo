import { useState } from 'react';
import CountdownTimer from './CountdownTimer.jsx';

export default function ReservationRow({ reservation, onConfirm, onCancel }) {
  const [actionLoading, setActionLoading] = useState(false);

  const handle = async (fn) => {
    setActionLoading(true);
    try {
      await fn();
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div className="reservation-row">
      <div className="res-info">
        <strong>{reservation.product_name || reservation.sku}</strong>
        <span>×{reservation.quantity}</span>
        <CountdownTimer expiresAt={reservation.expires_at} />
      </div>
      <div className="res-actions">
        <button
          className="btn-confirm"
          onClick={() => handle(() => onConfirm(reservation.id))}
          disabled={actionLoading}
        >
          ✅ Confirm
        </button>
        <button
          className="btn-cancel"
          onClick={() => handle(() => onCancel(reservation.id))}
          disabled={actionLoading}
        >
          ❌ Cancel
        </button>
      </div>
    </div>
  );
}