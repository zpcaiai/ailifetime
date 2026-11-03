import assert from 'node:assert/strict';
import test from 'node:test';
import { PHOTO_PRODUCTS, agePhotoProduct, photoProduct, wardrobeSeriesProduct } from '../dist/photo-catalog.js';

test('v3 albums have four exact count/quality prices while other totals and old quotes are preserved', () => {
  assert.deepEqual(PHOTO_PRODUCTS.map(p => [p.sku,p.amountMinor,p.currency]), [['lifespan-11-standard',1990,'CNY'],['lifespan-21-standard',2990,'CNY'],['lifespan-11-hd',2990,'CNY'],['lifespan-21',4990,'CNY'],['selected-age',590,'CNY'],['wardrobe-series',990,'CNY']]);
  assert.equal(photoProduct('lifespan-21').priceVersion, 'photo-retail-cny.v3');
  assert.equal(photoProduct('lifespan-21').imageCount, 21);
  assert.equal(photoProduct('lifespan-21','photo-retail-cny.v1').amountMinor,990);
  assert.equal(photoProduct('lifespan-21','photo-retail-cny.v2').amountMinor,4990);
  assert.throws(()=>photoProduct('lifespan-21','photo-retail-cny.v4'),/version/);
  assert.throws(()=>photoProduct('lifespan-11-hd','photo-retail-cny.v2'),/unknown/);
  assert.throws(() => { PHOTO_PRODUCTS[0].amountMinor = 1; }, TypeError);
  assert.throws(() => photoProduct('cheap-client-sku'), /unknown/);
});
test('each11/21 single/couple quality tier binds exact ages, dimensions and30day retention',()=>{
 for(const count of [11,21])for(const quality of ['standard','hd'])for(const couple of [false,true]){
  const ages=Array.from({length:count},(_,i)=>i*(count===11?10:5)),p=agePhotoProduct(`lifespan-${count}${couple?'-couple':''}-v1`,ages,quality);
  assert.equal(p.imageCount,count);assert.equal(p.imageQuality,quality);assert.equal(p.imageWidth,quality==='standard'?1536:2048);assert.equal(p.imageHeight,p.imageWidth);assert.equal(p.retentionDays,30);
  assert.equal(p.amountMinor,quality==='standard'?(count===11?1990:2990):(count===11?2990:4990));assert.deepEqual(p.targetAges,ages);
  for(const wrong of [ages.slice(1),[...ages].reverse(),ages.map(a=>a+1)])assert.throws(()=>agePhotoProduct(`lifespan-${count}-v1`,wrong,quality));
 }
 for(const quality of ['fast','4k','',null,{},['standard']])assert.throws(()=>agePhotoProduct('lifespan-11-v1',Array.from({length:11},(_,i)=>i*10),quality));
});
test('age price binds all exact 21 ages or one arbitrary integer age for either subject mode', () => {
  const ages = Array.from({length:21},(_,i)=>i*5);
  for (const profile of ['lifespan-21-v1','lifespan-21-couple-v1']) assert.equal(agePhotoProduct(profile,ages).amountMinor,4990);
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
