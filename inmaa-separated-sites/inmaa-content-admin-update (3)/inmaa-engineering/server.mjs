import http from "node:http";
import { createReadStream } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import crypto from "node:crypto";
import {
  ValidationError,
  calculateEstimate,
  getPricingConfig,
  publicPricingConfig
} from "./lib/pricing.mjs";
import {
  createBooking,
  createApartment,
  createSession,
  deleteApartment,
  findSession,
  getSiteContent,
  listAdminBookings,
  listApartments,
  listAreaSuggestions,
  listBookings,
  removeSession,
  updateApartment,
  updateBookingStatus,
  updateSiteContent,
  upsertUser
} from "./lib/database.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROLE = process.env.SITE_ROLE === "admin" ? "admin" : "public";
const PUBLIC_ROOT = path.join(ROOT, "apps", SITE_ROLE === "admin" ? "admin-site" : "public-site");
const MAX_BODY_BYTES = 64 * 1024;
const pricing = getPricingConfig();
const oauthStates = new Map();
const rateLimits = new Map();

async function activePricing() {
  const stored = await getSiteContent();
  const rates = stored.content?.pricing || {};
  const positive = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
  return { ...pricing, shellRate: positive(rates.shellRate, pricing.shellRate), finishRates: { economy: positive(rates.deluxeRate, pricing.finishRates.economy), standard: positive(rates.superDeluxeRate, pricing.finishRates.standard), premium: positive(rates.vipRate, pricing.finishRates.premium) } };
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

function securityLog(event, req, details = {}) {
  console.warn(JSON.stringify({
    event,
    ip: req.socket.remoteAddress || "unknown",
    path: new URL(req.url || "/", "http://localhost").pathname,
    at: new Date().toISOString(),
    ...details
  }));
}

function setSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(self), camera=(), microphone=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (String(process.env.APP_ORIGIN || "").startsWith("https://")) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  }
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; connect-src 'self' https://api.cloudinary.com; img-src 'self' data: https://res.cloudinary.com; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  );
}

function sendJson(res, statusCode, payload) {
  setSecurityHeaders(res);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function setCookie(res, name, value, { maxAge = 0, httpOnly = true, sameSite = "Lax" } = {}) {
  const secure = String(process.env.APP_ORIGIN || "").startsWith("https://") ? "; Secure" : "";
  const age = maxAge ? `; Max-Age=${maxAge}` : "; Max-Age=0";
  const httpOnlyFlag = httpOnly ? "; HttpOnly" : "";
  const cookie = `${name}=${encodeURIComponent(value)}; Path=/${httpOnlyFlag}; SameSite=${sameSite}${secure}${age}`;
  const current = res.getHeader("Set-Cookie");
  res.setHeader("Set-Cookie", current ? [...(Array.isArray(current) ? current : [current]), cookie] : cookie);
}

function readCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map((part) => part.trim().split(/=(.*)/s, 2))
      .filter(([name]) => name)
      .map(([name, value]) => [name, decodeURIComponent(value || "")])
  );
}

async function getSession(req) {
  const token = readCookies(req).inmaa_session;
  if (!token || !/^[0-9a-f-]{36}$/i.test(token)) return null;
  try {
    return await findSession(token);
  } catch (error) {
    if (error.message === "DATABASE_NOT_CONFIGURED") return null;
    throw error;
  }
}

async function sendSession(res, user) {
  const seconds = 60 * 60 * 24 * 14;
  const id = await createSession(user.id, new Date(Date.now() + seconds * 1000));
  setCookie(res, "inmaa_session", id, { maxAge: seconds, sameSite: "Strict" });
}

function ensureCsrfToken(req, res) {
  const token = readCookies(req).inmaa_csrf || crypto.randomBytes(24).toString("base64url");
  if (!readCookies(req).inmaa_csrf) setCookie(res, "inmaa_csrf", token, { maxAge: 60 * 60 * 24, httpOnly: false, sameSite: "Strict" });
  return token;
}

function requireCsrf(req) {
  const cookies = readCookies(req);
  const header = String(req.headers["x-csrf-token"] || "");
  if (!cookies.inmaa_csrf || !header || header !== cookies.inmaa_csrf) {
    securityLog("csrf_rejected", req);
    throw new ValidationError("انتهت جلسة الحماية. حدّث الصفحة وحاول مرة أخرى.");
  }
}

function limit(req, bucket, { max = 12, windowMs = 10 * 60 * 1000 } = {}) {
  const key = `${bucket}:${req.socket.remoteAddress || "unknown"}`;
  const now = Date.now();
  const item = rateLimits.get(key) || { count: 0, resetAt: now + windowMs };
  if (item.resetAt < now) Object.assign(item, { count: 0, resetAt: now + windowMs });
  item.count += 1;
  rateLimits.set(key, item);
  if (item.count > max) {
    securityLog("rate_limit", req, { bucket });
    const error = new ValidationError("محاولات كثيرة جدًا. حاول مرة أخرى بعد قليل.");
    error.code = "RATE_LIMITED";
    throw error;
  }
}

function authProviders() {
  return {
    google: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.APP_ORIGIN),
    github: Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET && process.env.APP_ORIGIN),
    phone: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_VERIFY_SERVICE_SID),
    assistant: Boolean(process.env.OPENAI_API_KEY)
  };
}

function siteConfig() {
  return {
    role: SITE_ROLE,
    publicOrigin: process.env.PUBLIC_ORIGIN || "",
    adminOrigin: process.env.ADMIN_ORIGIN || ""
  };
}

async function notifyBooking(booking, user) {
  const webhookUrl = String(process.env.BOOKING_WEBHOOK_URL || "").trim();
  if (!webhookUrl) return;
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "booking.created", booking, customer: publicUser(user) }),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) console.warn(JSON.stringify({ event: "booking_webhook_failed", status: response.status }));
  } catch (error) { console.warn(JSON.stringify({ event: "booking_webhook_error", message: error.message })); }
}

const CONTENT_DEFAULTS = {
  heroEyebrow: "قرار بناء أوضح",
  heroTitle: "اعرف كلفة مشروعك قبل أول حجر.",
  heroDescription: "أدخل مساحة البناء والموقع ومستوى التشطيب. تحصل فورًا على تقدير مبدئي للهيكل وللمشروع بعد التشطيب.",
  consultationTitle: "احجز استشارة مع مهندس.",
  consultationDescription: "راجع تقدير مشروعك مع مهندس إنماء واختر الموعد الذي يناسبك.",
  appTitle: "حمّل تطبيق إنماء.",
  appDescription: "تلقَّ تحديثات التقدير والحجوزات مباشرة على هاتفك عند إطلاق التطبيق.",
  contactPhone: "+962776878079",
  footerText: "من الفكرة إلى أرض الواقع، بأرقام أوضح وقرار أهدأ."
};

function validateSiteContent(payload) {
  const content = {};
  for (const [key, fallback] of Object.entries(CONTENT_DEFAULTS)) {
    const value = String(payload?.[key] ?? fallback).trim().replace(/\s+/g, " ");
    if (!value || value.length > 800) throw new ValidationError(`قيمة ${key} غير صالحة.`);
    content[key] = value;
  }
  if (!/^\+?[0-9]{8,15}$/.test(content.contactPhone.replace(/[\s()-]/g, ""))) throw new ValidationError("أدخل رقم تواصل صالحًا.", "contactPhone");
  content.overrides = Object.fromEntries(Object.entries(payload?.overrides || {}).filter(([key, value]) => String(key).length <= 800 && String(value).trim().length <= 800).map(([key, value]) => [String(key), String(value).trim()]));
  content.pricing = { shellRate: Number(payload?.pricing?.shellRate), deluxeRate: Number(payload?.pricing?.deluxeRate), superDeluxeRate: Number(payload?.pricing?.superDeluxeRate), vipRate: Number(payload?.pricing?.vipRate) };
  if (Object.values(content.pricing).some((value) => !Number.isFinite(value) || value <= 0 || value > 100000)) throw new ValidationError("أدخل أسعار متر صحيحة.");
  return content;
}

async function publicTextCatalog() {
  const markup = await readFile(path.join(ROOT, "apps", "public-site", "index.html"), "utf8");
  return [...new Set([...markup.matchAll(/>([^<>]+)</g)].map((match) => match[1].replace(/\s+/g, " ").trim()).filter((text) => text.length > 1 && text.length < 800))];
}

function redirect(res, location, cookie) {
  setSecurityHeaders(res);
  if (cookie) setCookie(res, cookie.name, cookie.value, cookie.options);
  res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  res.end();
}

function publicUser(user) {
  return user ? { id: user.id, name: user.name, email: user.email || null, avatarUrl: user.avatar_url || null, role: user.role } : null;
}

async function requireAdmin(req, res) {
  const user = await getSession(req);
  if (!user) {
    sendJson(res, 401, { error: "سجّل الدخول أولًا للوصول إلى لوحة الإدارة." });
    return null;
  }
  if (user.role !== "admin") {
    securityLog("admin_access_denied", req, { userId: user.id });
    sendJson(res, 403, { error: "لا تملك صلاحية الوصول إلى لوحة الإدارة." });
    return null;
  }
  return user;
}

function validateApartment(payload) {
  const title = String(payload.title || "").trim().replace(/\s+/g, " ");
  const area = String(payload.area || "").trim().replace(/\s+/g, " ");
  const finishType = String(payload.finishType || "");
  const price = Number(payload.price);
  const bedrooms = Number(payload.bedrooms);
  const bathrooms = Number(payload.bathrooms);
  const areaSqm = Number(payload.areaSqm);
  const floor = payload.floor === null || payload.floor === "" ? null : Number(payload.floor);
  const description = String(payload.description || "").trim();
  const status = String(payload.status || "published");
  if (title.length < 3 || title.length > 160) throw new ValidationError("أدخل عنوانًا واضحًا للشقة من 3 إلى 160 حرفًا.", "title");
  if (area.length < 2 || area.length > 100) throw new ValidationError("أدخل اسم المنطقة.", "area");
  if (!['super', 'super_deluxe', 'vip'].includes(finishType)) throw new ValidationError("اختر نوع تشطيب صالحًا.", "finishType");
  if (!Number.isFinite(price) || price <= 0 || price > 100000000) throw new ValidationError("أدخل سعرًا صالحًا.", "price");
  if (!Number.isInteger(bedrooms) || bedrooms < 0 || bedrooms > 30) throw new ValidationError("أدخل عدد غرف صالحًا.", "bedrooms");
  if (!Number.isInteger(bathrooms) || bathrooms < 0 || bathrooms > 30) throw new ValidationError("أدخل عدد حمامات صالحًا.", "bathrooms");
  if (!Number.isFinite(areaSqm) || areaSqm <= 0 || areaSqm > 100000) throw new ValidationError("أدخل مساحة صالحة.", "areaSqm");
  if (floor !== null && (!Number.isInteger(floor) || floor < -10 || floor > 300)) throw new ValidationError("أدخل رقم طابق صالحًا.", "floor");
  if (description.length > 4000) throw new ValidationError("الوصف أطول من المسموح.", "description");
  if (!['draft', 'published'].includes(status)) throw new ValidationError("حالة النشر غير صالحة.", "status");
  if (!Array.isArray(payload.images) || payload.images.length > 12) throw new ValidationError("يمكن إضافة حتى 12 صورة.", "images");
  return { title, area, finishType, price, bedrooms, bathrooms, areaSqm, floor, description, status, images: payload.images };
}

function cloudinarySignature() {
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = "inmaa/apartments";
  const source = `folder=${folder}&timestamp=${timestamp}${process.env.CLOUDINARY_API_SECRET}`;
  return { timestamp, folder, signature: crypto.createHash("sha1").update(source).digest("hex") };
}

function sendError(res, error) {
  if (error instanceof ValidationError) {
    return sendJson(res, 422, {
      error: error.message,
      field: error.field
    });
  }
  if (error?.code === "BODY_TOO_LARGE") {
    return sendJson(res, 413, { error: "حجم الطلب أكبر من المسموح" });
  }
  if (error?.code === "RATE_LIMITED") return sendJson(res, 429, { error: error.message });
  if (error?.message === "DATABASE_NOT_CONFIGURED") return sendJson(res, 503, { error: "قاعدة البيانات غير مهيّأة بعد." });
  if (error?.message === "DATABASE_DRIVER_NOT_INSTALLED") return sendJson(res, 503, { error: "شغّل npm install لتثبيت اتصال PostgreSQL." });
  if (error instanceof SyntaxError) {
    return sendJson(res, 400, { error: "صيغة البيانات غير صحيحة" });
  }
  console.error(error);
  return sendJson(res, 500, { error: "تعذر إكمال الطلب الآن. حاول مرة أخرى." });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    let tooLarge = false;

    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      if (tooLarge) {
        const error = new Error("Payload too large");
        error.code = "BODY_TOO_LARGE";
        reject(error);
        return;
      }
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function makeReference(date = new Date()) {
  const datePart = date.toISOString().slice(0, 10).replaceAll("-", "");
  const randomPart = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `INM-${datePart}-${randomPart}`;
}

async function exchangeGoogleCode(code) {
  const origin = process.env.APP_ORIGIN;
  const redirectUri = `${origin}/api/auth/google/callback`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code"
    })
  });
  if (!response.ok) throw new ValidationError("تعذر التحقق من حساب Google. حاول مرة أخرى.");
  const tokens = await response.json();
  const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` }
  });
  if (!profileResponse.ok) throw new ValidationError("تعذر قراءة بيانات حساب Google.");
  const profile = await profileResponse.json();
  if (!profile.sub || !profile.email) throw new ValidationError("لم يرسل Google بيانات الحساب المطلوبة.");
  return profile;
}

async function exchangeGithubCode(code) {
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${process.env.APP_ORIGIN}/api/auth/github/callback`
    })
  });
  const token = await tokenResponse.json();
  if (!tokenResponse.ok || !token.access_token) throw new ValidationError("تعذر التحقق من حساب GitHub. حاول مرة أخرى.");
  const headers = { Authorization: `Bearer ${token.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "inmaa-engineering-platform" };
  const [profileResponse, emailsResponse] = await Promise.all([
    fetch("https://api.github.com/user", { headers }),
    fetch("https://api.github.com/user/emails", { headers })
  ]);
  if (!profileResponse.ok) throw new ValidationError("تعذر قراءة بيانات حساب GitHub.");
  const profile = await profileResponse.json();
  const emails = emailsResponse.ok ? await emailsResponse.json() : [];
  const primary = Array.isArray(emails) && emails.find((item) => item.primary && item.verified);
  return { id: profile.id, name: profile.name || profile.login, email: profile.email || primary?.email || null, avatarUrl: profile.avatar_url || null };
}

async function reverseGeocode(latitude, longitude) {
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    throw new ValidationError("تحديد الموقع يحتاج مفتاح Google Maps في إعدادات الخادم.");
  }
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new ValidationError("إحداثيات الموقع غير صالحة.");
  }
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.search = new URLSearchParams({ latlng: `${lat},${lng}`, key: process.env.GOOGLE_MAPS_API_KEY, language: "ar" }).toString();
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok || data.status !== "OK" || !data.results?.[0]?.formatted_address) {
    throw new ValidationError("تعذر تحويل موقعك إلى عنوان. أدخل العنوان يدويًا.");
  }
  return data.results[0].formatted_address;
}

function normalizedPhone(value) {
  const phone = String(value || "").trim().replace(/[\s()-]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    throw new ValidationError("أدخل رقم الهاتف بصيغة دولية، مثل +9627…", "phone");
  }
  return phone;
}

async function twilioVerify(path, parameters) {
  const credentials = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
  const response = await fetch(`https://verify.twilio.com/v2/Services/${process.env.TWILIO_VERIFY_SERVICE_SID}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(parameters)
  });
  if (!response.ok) throw new ValidationError("تعذر التحقق من رقم الهاتف. تأكد من الرقم وحاول مرة أخرى.");
  return response.json();
}

async function askAssistant(message, project) {
  if (!process.env.OPENAI_API_KEY) {
    throw new ValidationError("المساعد غير مفعّل بعد. أضف OPENAI_API_KEY إلى إعدادات الخادم.");
  }
  const prompt = [
    "أنت مساعد منصة إنماء الهندسية. أجب بالعربية بوضوح وباختصار.",
    "لا تقدّم تصميمًا هندسيًا أو اعتمادًا رسميًا؛ اطلب مراجعة مهندس عند الحاجة.",
    project ? `بيانات المشروع الحالية: ${JSON.stringify(project)}` : "لا توجد بيانات مشروع حالية.",
    `سؤال العميل: ${message}`
  ].join("\n\n");
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model: process.env.OPENAI_MODEL || "gpt-4.1-mini", input: prompt })
  });
  if (!response.ok) throw new Error("تعذر الحصول على إجابة المساعد الآن.");
  const result = await response.json();
  const reply = String(result.output_text || "").trim();
  if (!reply) throw new Error("لم يُرجع المساعد إجابة. حاول مرة أخرى.");
  return reply;
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/health") {
    return sendJson(res, 200, { status: "ok", service: "inmaa-estimator" });
  }

  if (req.method === "GET" && pathname === "/api/config") {
    return sendJson(res, 200, publicPricingConfig(await activePricing()));
  }

  if (req.method === "GET" && pathname === "/api/site-config") {
    return sendJson(res, 200, siteConfig());
  }

  if (req.method === "GET" && pathname === "/api/content") {
    try {
      const stored = await getSiteContent();
      return sendJson(res, 200, { content: { ...CONTENT_DEFAULTS, ...(stored.content || {}) }, updatedAt: stored.updated_at });
    } catch (error) { return sendError(res, error); }
  }

  if (pathname === "/api/admin/content") {
    const user = await requireAdmin(req, res);
    if (!user) return;
    try {
      if (req.method === "GET") {
        const stored = await getSiteContent();
        return sendJson(res, 200, { content: { ...CONTENT_DEFAULTS, ...(stored.content || {}) }, updatedAt: stored.updated_at });
      }
      if (req.method === "PUT") {
        requireCsrf(req);
        limit(req, "admin-content-write", { max: 20 });
        return sendJson(res, 200, { content: (await updateSiteContent(validateSiteContent(await readJsonBody(req)))).content });
      }
    } catch (error) { return sendError(res, error); }
  }

  if (req.method === "GET" && pathname === "/api/admin/content/catalog") {
    const user = await requireAdmin(req, res);
    if (!user) return;
    try { return sendJson(res, 200, { texts: await publicTextCatalog() }); } catch (error) { return sendError(res, error); }
  }

  if (req.method === "GET" && pathname === "/api/areas") {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      return sendJson(res, 200, { areas: await listAreaSuggestions(url.searchParams.get("q") || "") });
    } catch (error) {
      return sendError(res, error);
    }
  }

  if (req.method === "GET" && pathname === "/api/apartments") {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      const finishType = String(url.searchParams.get("finish") || "");
      if (finishType && !['super', 'super_deluxe', 'vip'].includes(finishType)) throw new ValidationError("فلتر التشطيب غير صالح.");
      return sendJson(res, 200, await listApartments({
        area: url.searchParams.get("area") || "",
        finishType,
        cursor: url.searchParams.get("cursor") || "",
        limit: url.searchParams.get("limit") || 12
      }));
    } catch (error) {
      return sendError(res, error);
    }
  }

  if (req.method === "GET" && pathname === "/api/auth/session") {
    return sendJson(res, 200, { user: publicUser(await getSession(req)), providers: authProviders(), csrfToken: ensureCsrfToken(req, res) });
  }

  if (req.method === "POST" && pathname === "/api/auth/signout") {
    requireCsrf(req);
    const sessionId = readCookies(req).inmaa_session;
    if (sessionId) await removeSession(sessionId);
    setCookie(res, "inmaa_session", "");
    return sendJson(res, 200, { user: null });
  }

  if (req.method === "GET" && pathname === "/api/auth/google/start") {
    if (!authProviders().google) return sendJson(res, 503, { error: "تسجيل Google غير مفعّل بعد." });
    limit(req, "google-oauth", { max: 20 });
    const state = crypto.randomBytes(24).toString("base64url");
    oauthStates.set(state, Date.now() + 10 * 60 * 1000);
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: `${process.env.APP_ORIGIN}/api/auth/google/callback`,
      response_type: "code",
      scope: "openid email profile",
      state,
      prompt: "select_account"
    }).toString();
    return redirect(res, url.toString(), { name: "inmaa_oauth_state", value: state, options: { maxAge: 600 } });
  }

  if (req.method === "GET" && pathname === "/api/auth/google/callback") {
    const url = new URL(req.url || "/", "http://localhost");
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const expiresAt = oauthStates.get(state);
    oauthStates.delete(state);
    if (!state || !code || readCookies(req).inmaa_oauth_state !== state || !expiresAt || expiresAt < Date.now()) {
      securityLog("google_oauth_state_rejected", req);
      return redirect(res, "/?auth=error");
    }
    try {
      const profile = await exchangeGoogleCode(code);
      const user = await upsertUser({ provider: "google", providerId: profile.sub, name: profile.name, email: profile.email, avatarUrl: profile.picture || null });
      await sendSession(res, user);
      setCookie(res, "inmaa_oauth_state", "");
      return redirect(res, "/?auth=success");
    } catch (error) {
      console.error(error);
      return redirect(res, "/?auth=error");
    }
  }

  if (req.method === "GET" && pathname === "/api/auth/github/start") {
    if (!authProviders().github) return sendJson(res, 503, { error: "تسجيل GitHub غير مفعّل بعد." });
    limit(req, "github-oauth", { max: 20 });
    const state = crypto.randomBytes(24).toString("base64url");
    oauthStates.set(state, Date.now() + 10 * 60 * 1000);
    const url = new URL("https://github.com/login/oauth/authorize");
    url.search = new URLSearchParams({
      client_id: process.env.GITHUB_CLIENT_ID,
      redirect_uri: `${process.env.APP_ORIGIN}/api/auth/github/callback`,
      scope: "read:user user:email",
      state
    }).toString();
    return redirect(res, url.toString(), { name: "inmaa_oauth_state", value: state, options: { maxAge: 600 } });
  }

  if (req.method === "GET" && pathname === "/api/auth/github/callback") {
    const url = new URL(req.url || "/", "http://localhost");
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const expiresAt = oauthStates.get(state);
    oauthStates.delete(state);
    if (!state || !code || readCookies(req).inmaa_oauth_state !== state || !expiresAt || expiresAt < Date.now()) {
      securityLog("github_oauth_state_rejected", req);
      return redirect(res, "/?auth=error");
    }
    try {
      const profile = await exchangeGithubCode(code);
      const user = await upsertUser({ provider: "github", providerId: String(profile.id), name: profile.name, email: profile.email, avatarUrl: profile.avatarUrl });
      await sendSession(res, user);
      setCookie(res, "inmaa_oauth_state", "");
      return redirect(res, "/?auth=success");
    } catch (error) {
      console.error(error);
      return redirect(res, "/?auth=error");
    }
  }

  if (req.method === "POST" && pathname === "/api/auth/phone/start") {
    try {
      requireCsrf(req);
      limit(req, "phone-start", { max: 5 });
      if (!authProviders().phone) return sendJson(res, 503, { error: "تسجيل الهاتف غير مفعّل بعد." });
      const { phone } = await readJsonBody(req);
      const normalized = normalizedPhone(phone);
      await twilioVerify("Verifications", { To: normalized, Channel: "sms" });
      return sendJson(res, 200, { message: "تم إرسال الرمز." });
    } catch (error) {
      return sendError(res, error);
    }
  }

  if (req.method === "POST" && pathname === "/api/auth/phone/verify") {
    try {
      requireCsrf(req);
      limit(req, "phone-verify", { max: 8 });
      if (!authProviders().phone) return sendJson(res, 503, { error: "تسجيل الهاتف غير مفعّل بعد." });
      const { phone, code } = await readJsonBody(req);
      const normalized = normalizedPhone(phone);
      if (!/^\d{4,10}$/.test(String(code || ""))) throw new ValidationError("أدخل رمز التحقق الصحيح.", "code");
      const verification = await twilioVerify("VerificationCheck", { To: normalized, Code: String(code) });
      if (verification.status !== "approved") throw new ValidationError("رمز التحقق غير صحيح أو منتهي الصلاحية.", "code");
      const user = await upsertUser({ provider: "phone", providerId: normalized, name: "مستخدم إنماء", phone: normalized });
      await sendSession(res, user);
      return sendJson(res, 200, { user: publicUser(user) });
    } catch (error) {
      return sendError(res, error);
    }
  }

  if (req.method === "POST" && pathname === "/api/estimate") {
    try {
      const payload = await readJsonBody(req);
      return sendJson(res, 200, calculateEstimate(payload, await activePricing()));
    } catch (error) {
      return sendError(res, error);
    }
  }

  if (pathname === "/api/admin/apartments" && req.method === "GET") {
    const user = await requireAdmin(req, res);
    if (!user) return;
    try {
      const url = new URL(req.url || "/", "http://localhost");
      return sendJson(res, 200, await listApartments({
        area: url.searchParams.get("area") || "",
        finishType: url.searchParams.get("finish") || "",
        cursor: url.searchParams.get("cursor") || "",
        limit: url.searchParams.get("limit") || 30,
        includeDrafts: true
      }));
    } catch (error) {
      return sendError(res, error);
    }
  }

  if (pathname === "/api/admin/bookings" && req.method === "GET") {
    const user = await requireAdmin(req, res);
    if (!user) return;
    try { return sendJson(res, 200, { bookings: await listAdminBookings() }); } catch (error) { return sendError(res, error); }
  }

  const bookingMatch = pathname.match(/^\/api\/admin\/bookings\/([0-9a-f-]{36})$/i);
  if (bookingMatch && req.method === "PUT") {
    try {
      requireCsrf(req);
      const user = await requireAdmin(req, res);
      if (!user) return;
      const status = String((await readJsonBody(req)).status || "");
      if (!["pending", "confirmed", "completed", "cancelled"].includes(status)) throw new ValidationError("حالة الحجز غير صالحة.");
      const booking = await updateBookingStatus(bookingMatch[1], status);
      if (!booking) return sendJson(res, 404, { error: "الحجز غير موجود." });
      return sendJson(res, 200, { booking });
    } catch (error) { return sendError(res, error); }
  }

  if (pathname === "/api/admin/apartments" && req.method === "POST") {
    try {
      requireCsrf(req);
      const user = await requireAdmin(req, res);
      if (!user) return;
      limit(req, "admin-apartment-write", { max: 40 });
      const apartment = await createApartment(validateApartment(await readJsonBody(req)), user.id);
      return sendJson(res, 201, { apartment });
    } catch (error) {
      return sendError(res, error);
    }
  }

  const apartmentMatch = pathname.match(/^\/api\/admin\/apartments\/([0-9a-f-]{36})$/i);
  if (apartmentMatch && req.method === "PUT") {
    try {
      requireCsrf(req);
      const user = await requireAdmin(req, res);
      if (!user) return;
      limit(req, "admin-apartment-write", { max: 40 });
      const apartment = await updateApartment(apartmentMatch[1], validateApartment(await readJsonBody(req)));
      if (!apartment) return sendJson(res, 404, { error: "الشقة غير موجودة." });
      return sendJson(res, 200, { apartment });
    } catch (error) {
      return sendError(res, error);
    }
  }

  if (apartmentMatch && req.method === "DELETE") {
    try {
      requireCsrf(req);
      const user = await requireAdmin(req, res);
      if (!user) return;
      limit(req, "admin-apartment-delete", { max: 20 });
      const deleted = await deleteApartment(apartmentMatch[1]);
      return sendJson(res, deleted ? 200 : 404, deleted ? { deleted: true } : { error: "الشقة غير موجودة." });
    } catch (error) {
      return sendError(res, error);
    }
  }

  if (pathname === "/api/admin/cloudinary/signature" && req.method === "POST") {
    try {
      requireCsrf(req);
      const user = await requireAdmin(req, res);
      if (!user) return;
      limit(req, "admin-image-signature", { max: 60 });
      if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
        return sendJson(res, 503, { error: "Cloudinary غير مهيّأ بعد." });
      }
      return sendJson(res, 200, { cloudName: process.env.CLOUDINARY_CLOUD_NAME, apiKey: process.env.CLOUDINARY_API_KEY, ...cloudinarySignature() });
    } catch (error) {
      return sendError(res, error);
    }
  }

  if (req.method === "POST" && pathname === "/api/quotes") {
    try {
      requireCsrf(req);
      limit(req, "booking", { max: 6 });
      const user = await getSession(req);
      if (!user) return sendJson(res, 401, { error: "سجّل الدخول أولًا لحجز الاستشارة." });
      const payload = await readJsonBody(req);
      const estimate = calculateEstimate(payload.project, await activePricing());
      const note = String(payload.note || "").trim().slice(0, 1000) || null;
      const appointmentAt = payload.appointmentAt ? new Date(payload.appointmentAt) : null;
      if (appointmentAt && Number.isNaN(appointmentAt.getTime())) throw new ValidationError("اختر موعدًا صالحًا للاستشارة.", "appointmentAt");
      const reference = makeReference();
      const booking = await createBooking({ reference, userId: user.id, appointmentAt, note, project: estimate.project, estimate });
      void notifyBooking(booking, user);
      return sendJson(res, 201, {
        reference,
        createdAt: booking.created_at,
        estimate,
        message: "تم استلام طلبك وسيتم التواصل معك بعد مراجعة التقدير."
      });
    } catch (error) {
      return sendError(res, error);
    }
  }

  if (req.method === "GET" && pathname === "/api/bookings") {
    const user = await getSession(req);
    if (!user) return sendJson(res, 401, { error: "سجّل الدخول لعرض حجوزاتك." });
    return sendJson(res, 200, { bookings: await listBookings(user.id) });
  }

  if (req.method === "POST" && pathname === "/api/geocode/reverse") {
    try {
      requireCsrf(req);
      limit(req, "geocode", { max: 20, windowMs: 10 * 60 * 1000 });
      const { latitude, longitude } = await readJsonBody(req);
      return sendJson(res, 200, { address: await reverseGeocode(latitude, longitude) });
    } catch (error) {
      return sendError(res, error);
    }
  }

  if (req.method === "POST" && pathname === "/api/assistant") {
    try {
      requireCsrf(req);
      limit(req, "assistant", { max: 20 });
      const payload = await readJsonBody(req);
      const message = String(payload.message || "").trim();
      if (message.length < 1 || message.length > 2000) throw new ValidationError("اكتب سؤالًا من 1 إلى 2000 حرف.", "message");
      const reply = await askAssistant(message, payload.project || null);
      return sendJson(res, 200, { reply });
    } catch (error) {
      return sendError(res, error);
    }
  }

  return sendJson(res, 404, { error: "المسار غير موجود" });
}

async function serveStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendJson(res, 405, { error: "الطريقة غير مسموحة" });
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return sendJson(res, 400, { error: "المسار غير صالح" });
  }

  const requested = decodedPath === "/" ? "/index.html" : decodedPath;
  const filePath = path.resolve(PUBLIC_ROOT, `.${requested}`);
  if (!filePath.startsWith(`${PUBLIC_ROOT}${path.sep}`)) {
    return sendJson(res, 403, { error: "المسار غير مسموح" });
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw Object.assign(new Error("Not found"), { code: "ENOENT" });
    const extension = path.extname(filePath).toLowerCase();
    setSecurityHeaders(res);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
      "Content-Length": fileStat.size,
      "Cache-Control": extension === ".html" ? "no-cache" : "public, max-age=3600"
    });
    if (req.method === "HEAD") return res.end();
    createReadStream(filePath).pipe(res);
  } catch (error) {
    if (error.code === "ENOENT") {
      return sendJson(res, 404, { error: "الصفحة غير موجودة" });
    }
    return sendError(res, error);
  }
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const origin = String(process.env.APP_ORIGIN || "");
    const forwardedProtocol = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const secureRequest = Boolean(req.socket.encrypted) || forwardedProtocol === "https";
    const host = String(req.headers.host || "");
    if (origin.startsWith("https://") && !secureRequest && !host.startsWith("localhost") && !host.startsWith("127.0.0.1")) {
      return redirect(res, `${origin}${req.url || "/"}`);
    }
    const requestUrl = new URL(req.url || "/", "http://localhost");
    if (requestUrl.pathname.startsWith("/api/")) {
      return handleApi(req, res, requestUrl.pathname);
    }
    return serveStatic(req, res, requestUrl.pathname);
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const port = Number(process.env.PORT) || 3000;
  const server = createServer();
  server.listen(port, "0.0.0.0", () => {
    console.log(`Inmaa platform running on http://localhost:${port}`);
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
