const DEFAULT_LOCATIONS = [
  { code: "amman", name: "عمّان", multiplier: 1.08 },
  { code: "zarqa", name: "الزرقاء", multiplier: 0.98 },
  { code: "irbid", name: "إربد", multiplier: 1 },
  { code: "balqa", name: "البلقاء", multiplier: 1.03 },
  { code: "madaba", name: "مادبا", multiplier: 1 },
  { code: "other", name: "محافظة أخرى", multiplier: 1 }
];

const FINISH_LABELS = {
  economy: "ديلوكس",
  standard: "سوبر ديلوكس",
  premium: "VIP"
};

function positiveRate(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getPricingConfig(env = process.env) {
  return {
    currency: env.CURRENCY_LABEL?.trim() || "د.أ",
    shellRate: positiveRate(env.SHELL_RATE, 235),
    finishRates: {
      economy: positiveRate(env.ECONOMY_RATE, 390),
      standard: positiveRate(env.STANDARD_RATE, 455),
      premium: positiveRate(env.PREMIUM_RATE, 565)
    },
    stoneRate: positiveRate(env.STONE_RATE, 28),
    locations: DEFAULT_LOCATIONS.map((location) => ({ ...location })),
    lastUpdated: "2026-08-29"
  };
}

function asFiniteNumber(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ValidationError(`قيمة ${fieldName} غير صالحة`, fieldName);
  }
  return parsed;
}

function assertIntegerInRange(value, min, max, fieldName) {
  const parsed = asFiniteNumber(value, fieldName);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ValidationError(`يجب أن تكون قيمة ${fieldName} بين ${min} و${max}`, fieldName);
  }
  return parsed;
}

function roundMoney(value) {
  return Math.round(value);
}

function rangeFor(value) {
  return {
    min: roundMoney(value * 0.925),
    max: roundMoney(value * 1.075)
  };
}

export class ValidationError extends Error {
  constructor(message, field = null) {
    super(message);
    this.name = "ValidationError";
    this.field = field;
  }
}

export function normalizeProject(payload, pricing = getPricingConfig()) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ValidationError("بيانات المشروع مطلوبة");
  }

  const area = asFiniteNumber(payload.area, "المساحة");
  if (area < 40 || area > 50000) {
    throw new ValidationError("يجب أن تكون المساحة بين 40 و50,000 متر مربع", "area");
  }

  const floors = assertIntegerInRange(payload.floors, 1, 20, "عدد الطوابق");
  const stoneFacades = assertIntegerInRange(payload.stoneFacades, 0, 4, "واجهات الحجر");
  const location = pricing.locations.find((item) => item.code === payload.location);
  if (!location) {
    throw new ValidationError("اختر موقعًا من القائمة", "location");
  }

  const finishLevel = String(payload.finishLevel || "standard");
  if (!Object.hasOwn(pricing.finishRates, finishLevel)) {
    throw new ValidationError("اختر مستوى تشطيب صالحًا", "finishLevel");
  }

  const address = String(payload.address || "").trim().replace(/\s+/g, " ");
  if (address.length < 3 || address.length > 180) {
    throw new ValidationError("أدخل موقع المشروع بشكل أوضح", "address");
  }

  return {
    area: Math.round(area * 10) / 10,
    floors,
    stoneFacades,
    location: location.code,
    locationName: location.name,
    address,
    finishLevel,
    finishLabel: FINISH_LABELS[finishLevel]
  };
}

export function calculateEstimate(payload, pricing = getPricingConfig()) {
  const project = normalizeProject(payload, pricing);
  const location = pricing.locations.find((item) => item.code === project.location);
  const floorArea = project.area / project.floors;
  const aspectRatio = 1.25;
  const width = Math.sqrt(floorArea * aspectRatio);
  const depth = floorArea / width;
  const facadeWidths = [width, depth, width, depth];
  const netFacadeFactor = 0.78;
  const floorHeight = 3.2;
  const selectedFacadeWidth = facadeWidths
    .slice(0, project.stoneFacades)
    .reduce((sum, current) => sum + current, 0);
  const stoneArea = selectedFacadeWidth * floorHeight * project.floors * netFacadeFactor;

  const shellTotal = project.area * pricing.shellRate * location.multiplier;
  const finishedBase = project.area * pricing.finishRates[project.finishLevel] * location.multiplier;
  const stoneCost = stoneArea * pricing.stoneRate * location.multiplier;
  const finishedTotal = finishedBase + stoneCost;

  return {
    project,
    currency: pricing.currency,
    totals: {
      shell: roundMoney(shellTotal),
      finished: roundMoney(finishedTotal),
      difference: roundMoney(finishedTotal - shellTotal)
    },
    ranges: {
      shell: rangeFor(shellTotal),
      finished: rangeFor(finishedTotal)
    },
    breakdown: {
      shellRate: pricing.shellRate,
      finishedRate: pricing.finishRates[project.finishLevel],
      locationMultiplier: location.multiplier,
      stoneRate: pricing.stoneRate,
      estimatedStoneArea: Math.round(stoneArea),
      stoneCost: roundMoney(stoneCost)
    },
    dimensions: {
      footprintWidth: Math.round(width * 10) / 10,
      footprintDepth: Math.round(depth * 10) / 10,
      floorArea: Math.round(floorArea * 10) / 10,
      estimatedHeight: Math.round(project.floors * floorHeight * 10) / 10
    },
    disclaimer: "تقدير أولي لا يشمل ثمن الأرض أو الرسوم الحكومية أو أعمال التربة والاستنادات والخدمات الخارجية."
  };
}

export function publicPricingConfig(pricing = getPricingConfig()) {
  return {
    currency: pricing.currency,
    rates: {
      shell: pricing.shellRate,
      finishes: { ...pricing.finishRates },
      stone: pricing.stoneRate
    },
    finishLabels: { ...FINISH_LABELS },
    locations: pricing.locations.map(({ code, name, multiplier }) => ({ code, name, multiplier })),
    limits: {
      area: { min: 40, max: 50000 },
      floors: { min: 1, max: 20 },
      stoneFacades: { min: 0, max: 4 }
    },
    lastUpdated: pricing.lastUpdated
  };
}
