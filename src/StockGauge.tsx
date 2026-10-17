import type { CSSProperties } from 'react';
import { getStockLevel } from '../shared/stock-level.mjs';
import './stock-gauge.css';

type StockGaugeProps = {
 quantity: number;
 minimum: number;
 compact?: boolean;
 showLabel?: boolean;
};

/** The minimum sits at 80% of the bar; the remaining 20% shows a 25% reserve. */
export function StockGauge({quantity,minimum,compact=false,showLabel=true}:StockGaugeProps) {
 const stock=getStockLevel(quantity,minimum);
 const style={
  '--stock-fill':`${stock.fillPercent}%`,
  '--stock-minimum':`${stock.minimumPercent}%`,
 } as CSSProperties;
 return <span className={`stock-gauge${compact?' stock-gauge--compact':''}`} style={style} data-testid="stock-gauge" data-stock-level={stock.level} title={stock.description} role="meter" aria-label={stock.description} aria-valuemin={0} aria-valuemax={stock.meterMaximum} aria-valuenow={stock.meterValue} aria-valuetext={stock.description}>
  {showLabel&&<span className="stock-gauge__label" aria-hidden="true"><span>{stock.label}</span><span>{stock.level==='unset'?'—':`Мин. ${stock.minimumText}`}</span></span>}
  <span className="stock-gauge__track" aria-hidden="true"><span className="stock-gauge__fill"/>{stock.level!=='unset'&&<span className="stock-gauge__minimum"/>}</span>
 </span>;
}
