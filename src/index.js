import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import authRoutes         from './routes/auth.js';
import restaurantRoutes   from './routes/restaurants.js';
import menuRoutes         from './routes/menus.js';
import categoryRoutes     from './routes/categories.js';
import itemRoutes         from './routes/items.js';
import subscriptionRoutes from './routes/subscriptions.js';
import qrRoutes           from './routes/qrCodes.js';
import chapaWebhook       from './webhooks/chapa.js';
import { errorHandler }   from './middlewares/errorHandler.js';

const app = express();

// ── CORS — allow all origins in dev, specific in prod ────────
const allowedOrigins = process.env.CLIENT_URL
  ? [process.env.CLIENT_URL, 'http://localhost:3000', 'http://127.0.0.1:3000']
  : ['http://localhost:3000', 'http://127.0.0.1:3000'];

app.use(cors({
  origin: (origin, callback) => {
    // allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    console.warn('[CORS] Blocked origin:', origin);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(morgan('dev'));

// ── Chapa webhook needs raw body BEFORE json parser ──────────
app.use('/api/webhooks/chapa', express.raw({ type: '*/*' }), chapaWebhook);

// ── Body parsers ─────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Health check ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV,
    client_url: process.env.CLIENT_URL,
  });
});

// ── Routes ───────────────────────────────────────────────────
app.use('/api/auth',          authRoutes);
app.use('/api/restaurants',   restaurantRoutes);
app.use('/api/menus',         menuRoutes);
app.use('/api/categories',    categoryRoutes);
app.use('/api/items',         itemRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/qr',            qrRoutes);

// ── 404 ──────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ── Global error handler ─────────────────────────────────────
app.use(errorHandler);

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`
  ┌────────────────────────────────────────┐
  │   QR Menu Backend running              │
  │   http://localhost:${PORT}                │
  │   CLIENT_URL: ${process.env.CLIENT_URL || 'not set'}    │
  └────────────────────────────────────────┘
  `);
});

export default app;
