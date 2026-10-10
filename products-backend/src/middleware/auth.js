const jwt = require('jsonwebtoken');

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  // Don't crash-loop the deploy: fall back to a random per-boot secret (everyone
  // must log in again after a restart) and warn loudly.
  JWT_SECRET = require('crypto').randomBytes(32).toString('hex');
  console.warn('[warn] JWT_SECRET is not set - using a temporary random secret. Set JWT_SECRET in your environment.');
}

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

// Populates req.user if a valid token is present; does not block the request.
function attachUser(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      req.user = null;
    }
  }
  next();
}

// Requires a valid admin token.
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(401).json({ error: 'Admin login required.' });
  }
  next();
}

module.exports = { signToken, attachUser, requireAdmin };
