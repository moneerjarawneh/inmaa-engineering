import test from "node:test";
import assert from "node:assert/strict";
import {
  ValidationError,
  calculateEstimate,
  getPricingConfig
} from "../lib/pricing.mjs";

const pricing = getPricingConfig({
  CURRENCY_LABEL: "د.أ",
  SHELL_RATE: "200",
  ECONOMY_RATE: "350",
  STANDARD_RATE: "400",
  PREMIUM_RATE: "500",
  STONE_RATE: "25"
});

test("calculates shell and finished totals on the server", () => {
  const result = calculateEstimate(
    {
      area: 200,
      floors: 2,
      location: "irbid",
      address: "حي الجامعة",
      finishLevel: "standard",
      stoneFacades: 0
    },
    pricing
  );

  assert.equal(result.totals.shell, 40000);
  assert.equal(result.totals.finished, 80000);
  assert.equal(result.breakdown.stoneCost, 0);
  assert.equal(result.project.location, "irbid");
  assert.equal(result.project.locationName, "إربد");
  assert.equal(result.project.address, "حي الجامعة");
});

test("stone facades increase the finished estimate only", () => {
  const withoutStone = calculateEstimate(
    {
      area: 320,
      floors: 2,
      location: "irbid",
      address: "شارع رئيسي",
      finishLevel: "standard",
      stoneFacades: 0
    },
    pricing
  );
  const withStone = calculateEstimate(
    {
      area: 320,
      floors: 2,
      location: "irbid",
      address: "شارع رئيسي",
      finishLevel: "standard",
      stoneFacades: 2
    },
    pricing
  );

  assert.equal(withStone.totals.shell, withoutStone.totals.shell);
  assert.ok(withStone.totals.finished > withoutStone.totals.finished);
  assert.ok(withStone.breakdown.estimatedStoneArea > 0);
});

test("rejects unrealistic areas", () => {
  assert.throws(
    () =>
      calculateEstimate(
        {
          area: 10,
          floors: 1,
          location: "amman",
          address: "موقع واضح",
          finishLevel: "standard",
          stoneFacades: 1
        },
        pricing
      ),
    ValidationError
  );
});
