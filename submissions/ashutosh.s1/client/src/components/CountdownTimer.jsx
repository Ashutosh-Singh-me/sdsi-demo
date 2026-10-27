import { useState, useEffect } from 'react';

/**
 * Live countdown from now until expiresAt.
 * Shows remaining seconds, turns red and shows "EXPIRED" when time's up.
 */
export default function CountdownTimer({ expiresAt }) {
  const [remaining, setRemaining] = useState(calcRemaining(expiresAt));

  useEffect(() => {
    const update = () => setRemaining(calcRemaining(expiresAt));
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  if (remaining <= 0) {
    return <span className="timer expired">EXPIRED</span>;
  }

  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  const urgent = remaining <= 15;

  return (
    <span className={`timer ${urgent ? 'urgent' : ''}`}>
      ⏱ {mins}:{String(secs).padStart(2, '0')}
    </span>
  );
}

function calcRemaining(expiresAt) {
  const diff = Math.floor((new Date(expiresAt) - Date.now()) / 1000);
  return Math.max(0, diff);
}