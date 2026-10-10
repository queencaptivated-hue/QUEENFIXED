require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const { attachUser } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 4000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

app.use(helmet({ crossOriginResourcePolicy: false }));
// Accept "*", one URL, or a comma-separated list; ignore trailing slashes
// so "https://site.vercel.app/" still matches the browser's Origin header.
const originList = ALLOWED_ORIGIN.split(',').map(o => o.trim().replace(/\/+$/, '')).filter(Boolean);
app.use(cors({
  origin: originList.includes('*') ? true : (origin, cb) => cb(null, !origin || originList.includes(origin)),
}));
app.use(express.json({ limit: '3mb' })); // room for small uploaded images
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(attachUser);

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false });
app.use('/api/auth', authLimiter);

app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now() }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/products', require('./routes/products'));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 400).json({ error: err.message || 'Something went wrong.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Queen Captivated Products API listening on port ${PORT}`);
});
