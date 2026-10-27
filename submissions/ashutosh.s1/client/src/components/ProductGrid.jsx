import ProductCard from './ProductCard.jsx';

export default function ProductGrid({ products, userId, onReserve, userReservations }) {
  if (!products || products.length === 0) {
    return (
      <section className="panel">
        <h2>Products</h2>
        <p className="empty">No products loaded. Use Admin panel to load inventory.</p>
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>Products</h2>
      <div className="product-grid">
        {products.map((p) => (
          <ProductCard
            key={p.sku}
            product={p}
            onReserve={onReserve}
            userReservedQty={getUserActiveQty(userReservations, p.sku)}
          />
        ))}
      </div>
    </section>
  );
}

function getUserActiveQty(reservations, sku) {
  return reservations
    .filter((r) => r.sku === sku && r.status === 'active')
    .reduce((sum, r) => sum + r.quantity, 0);
}