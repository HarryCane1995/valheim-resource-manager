export type StockLevel = 'deficit' | 'near' | 'surplus' | 'unset';
export interface StockLevelResult {
  level: StockLevel;
  fillPercent: number;
  minimumPercent: number;
  meterMaximum: number;
  meterValue: number;
  shortfall: number;
  label: string;
  quantityText: string;
  minimumText: string;
  description: string;
}
export function getStockLevel(quantity: number, minimum: number): StockLevelResult;
