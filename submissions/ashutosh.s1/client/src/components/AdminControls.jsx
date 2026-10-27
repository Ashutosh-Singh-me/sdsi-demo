import { useState } from 'react';

export default function AdminControls({ onLoad, onCleanup, loading }) {
  const [showCustom, setShowCustom] = useState(false);
  const [jsonText, setJsonText] = useState('');

  const handleStandardLoad = () => onLoad(null);

  const handleCustomLoad = () => {
    try {
      const parsed = JSON.parse(jsonText);
      onLoad(parsed);
      setShowCustom(false);
    } catch {
      alert('Invalid JSON. Please check your syntax.');
    }
  };

  return (
    <section className="admin-controls">
      <h2>Admin</h2>
      <div className="btn-group">
        <button onClick={handleStandardLoad} disabled={loading}>
          {loading ? 'Loading...' : '📥 Load Default Inventory'}
        </button>
        <button onClick={onCleanup} disabled={loading}>
          🧹 Cleanup Expired
        </button>
        <button onClick={() => setShowCustom(!showCustom)}>
          📝 Custom JSON
        </button>
      </div>
      {showCustom && (
        <div className="custom-json">
          <textarea
            rows={8}
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            placeholder='[{"sku":"X","name":"Product X","total_stock":50,"max_per_user":2}]'
          />
          <button onClick={handleCustomLoad} disabled={loading}>
            Load Custom
          </button>
        </div>
      )}
    </section>
  );
}