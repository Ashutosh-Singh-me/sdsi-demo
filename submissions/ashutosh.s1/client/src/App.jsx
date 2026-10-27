import { useState, useEffect, useCallback } from 'react';
import { api } from './api/client.js';
import Header from './components/Header.jsx';
import AdminControls from './components/AdminControls.jsx';
import ProductGrid from './components/ProductGrid.jsx';
import ActiveReservations from './components/ActiveReservations.jsx';
import ErrorBanner from './components/ErrorBanner.jsx';

const DEFAULT_INVENTORY = [
  { sku: 'IPHONE-15', name: 'iPhone 15', total_stock: 100, max_per_user: 2 },
  { sku: 'AIRPODS-PRO', name: 'AirPods Pro', total_stock: 500, max_per_user: 5 },
  { sku: 'MACBOOK-AIR', name: 'MacBook Air M4', total_stock: 50, max_per_user: 1 },
  { sku: 'APPLE-WATCH', name: 'Apple Watch Series 10', total_stock: 200, max_per_user: 3 },
];

export default function App() {
  const [products, setProducts] = useState([]);
  const [userId, setUserId] = useState('user-1');
  const [reservations, setReservations] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [inv, res] = await Promise.all([
        api.getInventory(),
        userId ? api.getUserReservations(userId) : Promise.resolve({ reservations: [] }),
      ]);
      setProducts(inv.products);
      setReservations(res.reservations);
    } catch (e) {
      // Don't spam errors during initial empty state
      if (products.length > 0) setError(e.message);
    }
  }, [userId]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  const handleLoad = async (customProducts) => {
    setLoading(true);
    setError(null);
    try {
      const data = customProducts || DEFAULT_INVENTORY;
      await api.loadInventory(data);
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleReserve = async (sku, quantity) => {
    setError(null);
    try {
      await api.reserve(userId, sku, quantity);
      await refresh();
    } catch (e) {
      setError(e.message);
    }
  };

  const handleConfirm = async (reservationId) => {
    setError(null);
    try {
      await api.confirm(reservationId, userId);
      await refresh();
    } catch (e) {
      setError(e.message);
    }
  };

  const handleCancel = async (reservationId) => {
    setError(null);
    try {
      await api.cancel(reservationId, userId);
      await refresh();
    } catch (e) {
      setError(e.message);
    }
  };

  const handleCleanup = async () => {
    setError(null);
    try {
      await api.cleanup();
      await refresh();
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div className="app">
      <Header />
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <div className="toolbar">
        <label className="user-input">
          User ID:
          <input
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="user-1"
          />
        </label>
      </div>

      <AdminControls onLoad={handleLoad} onCleanup={handleCleanup} loading={loading} />

      <main className="layout">
        <ProductGrid
          products={products}
          userId={userId}
          onReserve={handleReserve}
          userReservations={reservations}
        />
        <ActiveReservations
          reservations={reservations}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      </main>
    </div>
  );
}
