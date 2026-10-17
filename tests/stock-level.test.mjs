import test from 'node:test';
import assert from 'node:assert/strict';
import { getStockLevel } from '../shared/stock-level.mjs';

test('stock boundaries use deficit below 200, warning below 250 and surplus from 250', () => {
 for (const [quantity,level] of [[0,'deficit'],[199,'deficit'],[200,'near'],[249,'near'],[250,'surplus'],[1000,'surplus']]) {
  const stock=getStockLevel(quantity,200);
  assert.equal(stock.level,level,`quantity ${quantity}`);
  assert.equal(stock.minimumPercent,80);
  assert.equal(stock.meterMaximum,250);
  assert.equal(stock.meterValue,Math.min(250,quantity));
  assert.equal(stock.shortfall,Math.max(0,200-quantity));
  assert.equal(stock.fillPercent,Math.min(100,quantity/200/1.25*100));
 }
});

test('a full gauge retains the actual amount for its accessible description', () => {
 const stock=getStockLevel(1250,200);
 assert.equal(stock.fillPercent,100);
 assert.equal(stock.meterValue,250);
 assert.match(stock.description,/1\s250/);
 assert.match(stock.description,/200/);
 assert.match(stock.description,/Профицит/);
});

test('zero, absent and invalid minimums stay neutral without a shortage alarm', () => {
 for (const minimum of [0,-200,NaN,Infinity,-Infinity,undefined,null,'200']) {
  const stock=getStockLevel(0,minimum);
  assert.equal(stock.level,'unset');
  assert.equal(stock.shortfall,0);
  assert.equal(stock.fillPercent,0);
  assert.equal(stock.minimumPercent,0);
  assert.equal(stock.label,'Минимум не задан');
 }
});

test('invalid quantities stay neutral rather than fabricating a count', () => {
 for (const quantity of [-1,NaN,Infinity,-Infinity,undefined,null,'100']) {
  const stock=getStockLevel(quantity,200);
  assert.equal(stock.level,'unset');
  assert.equal(stock.quantityText,'нет данных');
  assert.equal(stock.label,'Нет данных о запасе');
  assert.equal(stock.meterValue,0);
 }
});

test('fractional minimums use the same threshold and preserve precise input text', () => {
 assert.equal(getStockLevel(0.1,0.1).level,'near');
 assert.equal(getStockLevel(0.125,0.1).level,'surplus');
 assert.match(getStockLevel(0.000001,0.1).description,/0,000001/);
});

test('finite extremes never create infinite or out-of-range meter attributes', () => {
 for (const [quantity,minimum] of [[Number.MAX_VALUE,Number.MAX_VALUE],[Number.MAX_VALUE,1],[Number.MIN_VALUE,Number.MIN_VALUE],[0,Number.MIN_VALUE]]) {
  const stock=getStockLevel(quantity,minimum);
  for (const value of [stock.fillPercent,stock.minimumPercent,stock.meterMaximum,stock.meterValue,stock.shortfall])assert.ok(Number.isFinite(value));
  assert.ok(stock.meterMaximum>0);
  assert.ok(stock.meterValue>=0&&stock.meterValue<=stock.meterMaximum);
  assert.ok(stock.fillPercent>=0&&stock.fillPercent<=100);
  assert.ok(stock.minimumPercent>=0&&stock.minimumPercent<=100);
 }
});
