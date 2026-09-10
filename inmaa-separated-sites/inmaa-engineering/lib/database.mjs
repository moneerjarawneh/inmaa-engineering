import crypto from "node:crypto";

let poolPromise;

function databaseUrl() {
  const value = String(process.env.DATABASE_URL || "").trim();
  if (!value) throw new Error("DATABASE_NOT_CONFIGURED");
  return value;
}

async function pool() {
  if (!poolPromise) {
    poolPromise = import("pg").catch(() => {
      throw new Error("DATABASE_DRIVER_NOT_INSTALLED");
    }).then(async ({ Pool }) => {
      const client = new Pool({
        connectionString: databaseUrl(),
        ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false }
      });
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id UUID PRIMARY KEY,
          provider TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          name TEXT NOT NULL,
          email TEXT,
          avatar_url TEXT,
          phone TEXT,
          role TEXT NOT NULL DEFAULT 'customer',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(provider, provider_id)
        );
        CREATE TABLE IF NOT EXISTS sessions (
          id UUID PRIMARY KEY,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS bookings (
          id UUID PRIMARY KEY,
          reference TEXT NOT NULL UNIQUE,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          appointment_at TIMESTAMPTZ,
          note TEXT,
          project JSONB NOT NULL,
          estimate JSONB NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS bookings_user_created_idx ON bookings(user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
        CREATE TABLE IF NOT EXISTS areas (
          id UUID PRIMARY KEY,
          name TEXT NOT NULL,
          normalized_name TEXT NOT NULL UNIQUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS apartments (
          id UUID PRIMARY KEY,
          title TEXT NOT NULL,
          area_id UUID NOT NULL REFERENCES areas(id) ON DELETE RESTRICT,
          finish_type TEXT NOT NULL CHECK (finish_type IN ('super', 'super_deluxe', 'vip')),
          price NUMERIC(14, 2) NOT NULL CHECK (price > 0),
          bedrooms SMALLINT NOT NULL CHECK (bedrooms >= 0 AND bedrooms <= 30),
          bathrooms SMALLINT NOT NULL CHECK (bathrooms >= 0 AND bathrooms <= 30),
          area_sqm NUMERIC(10, 2) NOT NULL CHECK (area_sqm > 0),
          floor SMALLINT,
          description TEXT,
          status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published')),
          created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS apartment_images (
          id UUID PRIMARY KEY,
          apartment_id UUID NOT NULL REFERENCES apartments(id) ON DELETE CASCADE,
          url TEXT NOT NULL,
          public_id TEXT,
          sort_order SMALLINT NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS apartments_area_finish_price_idx ON apartments(area_id, finish_type, price) WHERE status = 'published';
        CREATE INDEX IF NOT EXISTS apartments_created_idx ON apartments(created_at DESC, id DESC) WHERE status = 'published';
        CREATE INDEX IF NOT EXISTS apartment_images_apartment_idx ON apartment_images(apartment_id, sort_order);
        CREATE TABLE IF NOT EXISTS site_content (
          id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
          content JSONB NOT NULL DEFAULT '{}'::jsonb,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      return client;
    });
  }
  return poolPromise;
}

export async function getSiteContent() {
  const db = await pool();
  const { rows } = await db.query("SELECT content, updated_at FROM site_content WHERE id = TRUE");
  return rows[0] || { content: {}, updated_at: null };
}

export async function updateSiteContent(content) {
  const db = await pool();
  const { rows } = await db.query(
    `INSERT INTO site_content (id, content) VALUES (TRUE, $1::jsonb)
     ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()
     RETURNING content, updated_at`,
    [JSON.stringify(content)]
  );
  return rows[0];
}

export async function upsertUser({ provider, providerId, name, email = null, avatarUrl = null, phone = null }) {
  const db = await pool();
  const id = crypto.randomUUID();
  const adminEmails = String(process.env.ADMIN_EMAILS || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  const role = email && adminEmails.includes(email.toLowerCase()) ? "admin" : "customer";
  const { rows } = await db.query(
    `INSERT INTO users (id, provider, provider_id, name, email, avatar_url, phone, role)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (provider, provider_id) DO UPDATE SET
       name = EXCLUDED.name, email = EXCLUDED.email, avatar_url = EXCLUDED.avatar_url,
       phone = COALESCE(EXCLUDED.phone, users.phone), role = EXCLUDED.role, updated_at = NOW()
     RETURNING id, name, email, avatar_url, phone, role`,
    [id, provider, providerId, name, email, avatarUrl, phone, role]
  );
  return rows[0];
}

export async function createSession(userId, expiresAt) {
  const db = await pool();
  const id = crypto.randomUUID();
  await db.query("INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)", [id, userId, expiresAt]);
  return id;
}

export async function findSession(sessionId) {
  const db = await pool();
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.email, u.avatar_url, u.phone, u.role
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.expires_at > NOW()`,
    [sessionId]
  );
  return rows[0] || null;
}

export async function removeSession(sessionId) {
  const db = await pool();
  await db.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
}

export async function createBooking({ reference, userId, appointmentAt, note, project, estimate }) {
  const db = await pool();
  const { rows } = await db.query(
    `INSERT INTO bookings (id, reference, user_id, appointment_at, note, project, estimate)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, reference, appointment_at, status, created_at`,
    [crypto.randomUUID(), reference, userId, appointmentAt, note, project, estimate]
  );
  return rows[0];
}

export async function listBookings(userId) {
  const db = await pool();
  const { rows } = await db.query(
    `SELECT reference, appointment_at, note, status, project, created_at
     FROM bookings WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return rows;
}

function normalizedArea(name) {
  return String(name || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("ar");
}

export async function createOrGetArea(name) {
  const clean = String(name || "").trim().replace(/\s+/g, " ");
  if (clean.length < 2 || clean.length > 100) throw new Error("INVALID_AREA");
  const db = await pool();
  const id = crypto.randomUUID();
  const { rows } = await db.query(
    `INSERT INTO areas (id, name, normalized_name) VALUES ($1, $2, $3)
     ON CONFLICT (normalized_name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, name`,
    [id, clean, normalizedArea(clean)]
  );
  return rows[0];
}

export async function listAreaSuggestions(query) {
  const db = await pool();
  const normalized = normalizedArea(query);
  if (!normalized) return [];
  const { rows } = await db.query(
    `SELECT name FROM areas WHERE normalized_name LIKE $1 ORDER BY name ASC LIMIT 8`,
    [`${normalized}%`]
  );
  return rows.map((row) => row.name);
}

function apartmentValues(input, areaId) {
  return [
    String(input.title || "").trim(), areaId, input.finishType, Number(input.price), Number(input.bedrooms),
    Number(input.bathrooms), Number(input.areaSqm), input.floor === null || input.floor === "" ? null : Number(input.floor),
    String(input.description || "").trim() || null, input.status || "published"
  ];
}

export async function createApartment(input, userId) {
  const area = await createOrGetArea(input.area);
  const db = await pool();
  const id = crypto.randomUUID();
  const { rows } = await db.query(
    `INSERT INTO apartments (id, title, area_id, finish_type, price, bedrooms, bathrooms, area_sqm, floor, description, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [id, ...apartmentValues(input, area.id), userId]
  );
  await replaceApartmentImages(rows[0].id, input.images || []);
  return getApartment(rows[0].id, true);
}

export async function updateApartment(id, input) {
  const area = await createOrGetArea(input.area);
  const db = await pool();
  const { rowCount } = await db.query(
    `UPDATE apartments SET title=$2, area_id=$3, finish_type=$4, price=$5, bedrooms=$6, bathrooms=$7,
     area_sqm=$8, floor=$9, description=$10, status=$11, updated_at=NOW() WHERE id=$1`,
    [id, ...apartmentValues(input, area.id)]
  );
  if (!rowCount) return null;
  await replaceApartmentImages(id, input.images || []);
  return getApartment(id, true);
}

async function replaceApartmentImages(apartmentId, images) {
  const db = await pool();
  const safe = Array.isArray(images) ? images.slice(0, 12) : [];
  await db.query("DELETE FROM apartment_images WHERE apartment_id = $1", [apartmentId]);
  for (let index = 0; index < safe.length; index += 1) {
    const image = safe[index];
    if (!image?.url || String(image.url).length > 2000) throw new Error("INVALID_IMAGE");
    await db.query(
      "INSERT INTO apartment_images (id, apartment_id, url, public_id, sort_order) VALUES ($1, $2, $3, $4, $5)",
      [crypto.randomUUID(), apartmentId, String(image.url), String(image.publicId || "") || null, index]
    );
  }
}

export async function deleteApartment(id) {
  const db = await pool();
  const { rowCount } = await db.query("DELETE FROM apartments WHERE id = $1", [id]);
  return rowCount > 0;
}

async function getApartment(id, includeDrafts) {
  const db = await pool();
  const { rows } = await db.query(
    `SELECT a.id, a.title, ar.name AS area, a.finish_type AS "finishType", a.price::float8 AS price,
       a.bedrooms, a.bathrooms, a.area_sqm::float8 AS "areaSqm", a.floor, a.description, a.status,
       a.created_at AS "createdAt", COALESCE(json_agg(json_build_object('url', i.url, 'publicId', i.public_id, 'sortOrder', i.sort_order)
       ORDER BY i.sort_order) FILTER (WHERE i.id IS NOT NULL), '[]') AS images
     FROM apartments a JOIN areas ar ON ar.id = a.area_id LEFT JOIN apartment_images i ON i.apartment_id = a.id
     WHERE a.id = $1 ${includeDrafts ? "" : "AND a.status = 'published'"}
     GROUP BY a.id, ar.name`, [id]
  );
  return rows[0] || null;
}

export async function listApartments({ area = "", finishType = "", cursor = "", limit = 12, includeDrafts = false }) {
  const db = await pool();
  const size = Math.min(Math.max(Number(limit) || 12, 1), 30);
  const cursorData = cursor ? JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) : null;
  const values = [];
  const filters = [includeDrafts ? "TRUE" : "a.status = 'published'"];
  if (area.trim()) { values.push(`%${normalizedArea(area)}%`); filters.push(`ar.normalized_name LIKE $${values.length}`); }
  if (finishType) { values.push(finishType); filters.push(`a.finish_type = $${values.length}`); }
  if (cursorData?.createdAt && cursorData?.id) {
    values.push(cursorData.createdAt, cursorData.id);
    filters.push(`(a.created_at, a.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
  }
  values.push(size + 1);
  const { rows } = await db.query(
    `SELECT a.id, a.title, ar.name AS area, a.finish_type AS "finishType", a.price::float8 AS price,
       a.bedrooms, a.bathrooms, a.area_sqm::float8 AS "areaSqm", a.floor, a.description, a.status,
       a.created_at AS "createdAt", COALESCE(json_agg(json_build_object('url', i.url, 'publicId', i.public_id, 'sortOrder', i.sort_order)
       ORDER BY i.sort_order) FILTER (WHERE i.id IS NOT NULL), '[]') AS images
     FROM apartments a JOIN areas ar ON ar.id = a.area_id LEFT JOIN apartment_images i ON i.apartment_id = a.id
     WHERE ${filters.join(" AND ")}
     GROUP BY a.id, ar.name ORDER BY a.created_at DESC, a.id DESC LIMIT $${values.length}`,
    values
  );
  const hasMore = rows.length > size;
  const items = rows.slice(0, size);
  const last = items.at(-1);
  return { items, nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id })).toString("base64url") : null };
}
