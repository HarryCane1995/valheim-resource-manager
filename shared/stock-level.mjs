const formatNumber = value => Number.isInteger(value) && Math.abs(value) < 1e21
  ? value.toLocaleString('ru-RU')
  : String(value).replace('.', ',');

/** A reserve of 25% above the minimum marks a comfortable stock level. */
export function getStockLevel(quantity, minimum) {
  const validQuantity = typeof quantity === 'number' && Number.isFinite(quantity) && quantity >= 0;
  const validMinimum = typeof minimum === 'number' && Number.isFinite(minimum) && minimum > 0;
  const quantityText = validQuantity ? formatNumber(quantity) : 'нет данных';
  const minimumText = validMinimum ? formatNumber(minimum) : 'не задан';
  if (!validQuantity || !validMinimum) {
    const label = !validQuantity ? 'Нет данных о запасе' : 'Минимум не задан';
    return {
      level: 'unset', fillPercent: 0, minimumPercent: 0,
      meterMaximum: 1, meterValue: 0, shortfall: 0,
      label, quantityText, minimumText,
      description: `Запас: ${quantityText}; минимум: ${minimumText}. ${label}.`,
    };
  }

  // Divide before multiplying so finite, very large inputs never overflow the scale.
  const ratio = quantity / minimum;
  const level = quantity < minimum ? 'deficit' : ratio < 1.25 ? 'near' : 'surplus';
  const label = level === 'deficit' ? 'Дефицит' : level === 'near' ? 'Близко к дефициту' : 'Профицит';
  const meterMaximum = Math.min(Number.MAX_VALUE, minimum * 1.25 || Number.MIN_VALUE);
  const shortfall = Math.max(0, minimum - quantity);
  return {
    level,
    fillPercent: Math.min(100, ratio / 1.25 * 100),
    minimumPercent: Math.min(100, minimum / meterMaximum * 100),
    meterMaximum,
    meterValue: Math.min(meterMaximum, quantity),
    shortfall,
    label, quantityText, minimumText,
    description: `Запас: ${quantityText}; минимум: ${minimumText}. ${label}${shortfall ? `: не хватает ${formatNumber(shortfall)}` : ''}.`,
  };
}
