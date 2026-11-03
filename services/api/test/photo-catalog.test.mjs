import assert from 'node:assert/strict';
import test from 'node:test';
import { PHOTO_PRODUCTS, agePhotoProduct, photoProduct, wardrobeSeriesProduct } from '../dist/photo-catalog.js';

test('retail totals are exactly 990/590/990 CNY cents per bundle', () => {
  assert.deepEqual(PHOTO_PRODUCTS.map(p => [p.sku,p.amountMinor,p.currency]), [['lifespan-21',990,'CNY'],['selected-age',590,'CNY'],['wardrobe-series',990,'CNY']]);
  assert.throws(() => { PHOTO_PRODUCTS[0].amountMinor = 1; }, TypeError);
  assert.throws(() => photoProduct('cheap-client-sku'), /unknown/);
});
test('age price binds all exact 21 ages or one arbitrary integer age for either subject mode', () => {
  const ages = Array.from({length:21},(_,i)=>i*5);
  for (const profile of ['lifespan-21-v1','lifespan-21-couple-v1']) assert.equal(agePhotoProduct(profile,ages).amountMinor,990);
  for (const profile of ['single-age-v1','single-age-couple-v1']) assert.deepEqual(agePhotoProduct(profile,[37]).targetAges,[37]);
  for (const [p,a] of [['custom',ages],['lifespan-21-v1',[...ages].reverse()],['lifespan-21-v1',ages.slice(1)],['single-age-v1',[5,10]],['single-age-v1',[-1]],['single-age-v1',[101]],['single-age-v1',['30']],['single-age-v1',[3.5]]]) assert.throws(()=>agePhotoProduct(p,a));
});
test('990 cents buys every eligible style in one series, with no per-style multiplication', () => {
  assert.equal(wardrobeSeriesProduct('east',30,1).amountMinor,990);
  assert.deepEqual(wardrobeSeriesProduct('east',30,1).styleIds,['east-pankou-v1','east-song-v1','east-qipao-v1','east-hanfu-v1']);
  const all=['east','retro','together','daily','wedding','milestone','winter','newyear'].map(id=>wardrobeSeriesProduct(id,50,2));
  assert.equal(all.reduce((sum,p)=>sum+p.imageCount,0),31);
  assert.ok(all.every(p=>p.amountMinor===990 && p.imageCount===p.styles.length && p.styleIds.length===p.imageCount));
});
test('series eligibility preserves age and couple restrictions, rejects empty or legacy bundles', () => {
  assert.equal(wardrobeSeriesProduct('newyear',0,1).imageCount,2);
  assert.equal(wardrobeSeriesProduct('newyear',30,2).imageCount,3);
  assert.equal(wardrobeSeriesProduct('milestone',0,1).imageCount,1);
  assert.equal(wardrobeSeriesProduct('together',30,2).imageCount,3);
  assert.equal(wardrobeSeriesProduct('together',50,2).imageCount,4);
  for(const args of [['together',30,1],['together',17,2],['wedding',17,1],['legacy',30,1],['east','30',1],['east',30,3],['east',-1,1]]) assert.throws(()=>wardrobeSeriesProduct(...args));
});
