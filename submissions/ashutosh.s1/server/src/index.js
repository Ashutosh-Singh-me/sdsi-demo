import express from 'express';
import cors from 'cors';
import { getDb, closeDb } from './db.js';
import inventoryRoutes from './routes/inventory.js';
import reservationRoutes from './routes/reservations.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Initialize database on startup
getDb();
console.log('Database initialized (WAL mode)');

// Routes
app.use('/api/inventory', inventoryRoutes);
app.use('/api/reservations', reservationRoutes);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Global error handler
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  closeDb();
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  closeDb();
  server.close(() => process.exit(0));
});

export default app;