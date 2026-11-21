import jwt from "jsonwebtoken";
import { q } from "./db.js";

// Tokens are issued by the events login module (OTP/email). Payload: { sub: profileId }.
export function requireAuth(req, res, next) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return res.status(401).json({ error: "Please log in." });
  try {
    req.user = jwt.verify(h.slice(7), process.env.EVENTS_JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Session expired. Please log in again." });
  }
}

// Roles are read from the database on every request, never trusted from the token.
export const requireRole = (...roles) => async (req, res, next) => {
  const { rows } = await q(
    `SELECT r.code FROM profile_roles pr JOIN roles r ON r.id = pr.role_id WHERE pr.profile_id = $1`,
    [req.user.sub]
  );
  req.roles = rows.map((r) => r.code);
  if (!req.roles.some((r) => roles.includes(r))) return res.status(403).json({ error: "You don’t have access to this." });
  next();
};

export const isAdmin = (req) => req.roles?.some((r) => r === "admin" || r === "super_admin");

export async function audit(client, actorId, action, entity, entityId, before, after) {
  await (client || { query: q }).query(
    `INSERT INTO audit_logs(actor_id, action, entity, entity_id, before, after) VALUES ($1,$2,$3,$4,$5,$6)`,
    [actorId, action, entity, String(entityId), before ?? null, after ?? null]
  );
}
