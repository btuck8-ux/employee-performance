/**
 * Unit tests for the 7shifts wage extraction (kickoff §5-A). The cents→
 * dollars treatment mirrors time.ts's punches convention — the repo's only
 * other hourly_wage consumer.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractWageFields } from "./enrich.ts";

test("hourly_wage cents convert to dollars, wage_type gets EPD casing", () => {
  assert.deepEqual(extractWageFields({ hourly_wage: 1550, wage_type: "hourly" }), {
    wage: 15.5,
    wagePayType: "Hourly",
  });
  assert.deepEqual(
    extractWageFields({ hourly_wage: 2000, wage_type: "salaried" }),
    { wage: 20, wagePayType: "Salaried" }
  );
});

test("zero or missing wage reads as not-set — never 0, and no bare pay type", () => {
  assert.deepEqual(extractWageFields({ hourly_wage: 0, wage_type: "hourly" }), {
    wage: null,
    wagePayType: null,
  });
  assert.deepEqual(extractWageFields({ wage_type: "hourly" }), {
    wage: null,
    wagePayType: null,
  });
  assert.deepEqual(extractWageFields({}), { wage: null, wagePayType: null });
});

test("non-numeric junk never becomes a wage", () => {
  assert.deepEqual(extractWageFields({ hourly_wage: "1550" }), {
    wage: null,
    wagePayType: null,
  });
  assert.deepEqual(extractWageFields({ hourly_wage: NaN }), {
    wage: null,
    wagePayType: null,
  });
  assert.deepEqual(extractWageFields({ hourly_wage: -100 }), {
    wage: null,
    wagePayType: null,
  });
});

test("wage without a wage_type still surfaces the amount", () => {
  assert.deepEqual(extractWageFields({ hourly_wage: 1725 }), {
    wage: 17.25,
    wagePayType: null,
  });
});
