import { useState } from 'react';

export default function ProductCard({ product, onReserve, userReservedQty }) {
  const [quantity, setQuantity] = useState(1);
  const [reserving, setReserving] = useState(false);

  const maxCanReserve = Math.min(
    product.available,
    product.max_per_user - userReservedQty
  );

  const canReserve = maxCanReserve > 0 && product.available > 0;

  const handleReserve = async () => {
    setReserving(true);
    try {
      await onReserve(product.sku, quantity);
    } finally {
      setReserving(false);
    }
  };

  const stockPct = product.total_stock > 0
    ? Math.round((product.available / product.total_stock) * 100)
    : 0;

  return (
    <div className={`product-card ${product.available === 0 ? 'sold-out' : ''}`}>
      <div className="product-header">
        <h3>{product.name}</h3>
        <code>{product.sku}</code>
      </div>

      <div className="stock-bar">
        <div className="stock-bar-fill" style={{ width: `${stockPct}%` }} />
        <span className="stock-pct">{stockPct}% available</span>
      </div>

      <div className="product-stats">
        <div className="stat">
          <span className="stat-label">Available</span>
          <span className="stat-value available">{product.available}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Reserved</span>
          <span className="stat-value reserved">{product.reserved}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Sold</span>
          <span className="stat-value sold">{product.sold}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Limit/User</span>
          <span className="stat-value">{product.max_per_user}</span>
        </div>
      </div>

      <div className="reserve-row">
        <input
          type="number"
          min={1}
          max={maxCanReserve}
          value={quantity}
          onChange={(e) => setQuantity(Math.max(1, parseInt(e.target.value) || 1))}
          disabled={!canReserve || reserving}
        />
        <button
          onClick={handleReserve}
          disabled={!canReserve || reserving}
        >
          {reserving ? '...' : '🔒 Reserve'}
        </button>
        {userReservedQty > 0 && (
          <span className="user-held">You: {userReservedQty} held</span>
        )}
      </div>
    </div>
  );
}