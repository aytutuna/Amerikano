export const REGIONS = ['am', 'eu', 'tr', 'mea', 'ap'];
export const DEFAULT = 'eu';

const CONTINENT = { NA: 'am', SA: 'am', EU: 'eu', AF: 'mea', AS: 'ap', OC: 'ap' };
const COUNTRY = { TR: 'tr', CY: 'eu', AM: 'eu', AZ: 'eu', GE: 'eu' };
for (const c of ['AE', 'SA', 'QA', 'KW', 'BH', 'OM', 'IQ', 'IR', 'JO', 'LB', 'SY', 'IL', 'PS', 'YE']) COUNTRY[c] = 'mea';

export const regionOf = (country, continent) => COUNTRY[country] || CONTINENT[continent] || DEFAULT;

// Table codes start with a letter that says where the room lives, so a code alone picks its Durable Object's location.
// The hint only counts when the object is first made, and codes are reused, so the letters never change place.
export const LEADS = { am: 'ABC', eu: 'DEF', tr: 'GHJ', mea: 'KMN', ap: 'PQR' };
export const PRIVATE = 'STUVWXYZ';
const HINTS = { am: 'enam', eu: 'weur', tr: 'eeur', mea: 'me', ap: 'apac' };

export const codeRegion = code => REGIONS.find(x => LEADS[x].includes(code[0]));

export function hint(code) {
  const r = codeRegion(code);
  return r && { locationHint: HINTS[r] };
}
