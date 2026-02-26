const UNIT_CONVERSIONS = {
  kg_to_g: 1000, g_to_kg: 0.001,
  L_to_ml: 1000, ml_to_L: 0.001,
  kg_to_mg: 1000000, mg_to_kg: 0.000001,
  L_to_cups: 4.22675, cups_to_L: 0.236588,
  oz_to_g: 28.3495, g_to_oz: 0.035274,
  oz_to_ml: 29.5735, ml_to_oz: 0.033814,
  lb_to_g: 453.592, g_to_lb: 0.00220462,
  lb_to_kg: 0.453592, kg_to_lb: 2.20462
};

function convertUnit(value, fromUnit, toUnit) {
  if (fromUnit === toUnit) return value;
  const key = fromUnit + '_to_' + toUnit;
  if (UNIT_CONVERSIONS[key]) return value * UNIT_CONVERSIONS[key];
  const reverseKey = toUnit + '_to_' + fromUnit;
  if (UNIT_CONVERSIONS[reverseKey]) return value / UNIT_CONVERSIONS[reverseKey];
  return value; // No conversion found, assume same unit
}

module.exports = { convertUnit, UNIT_CONVERSIONS };
