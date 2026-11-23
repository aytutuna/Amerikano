// push texts for the languages beyond English and Turkish, which live in push.js
import es from './text/es.js';

const more = { es };

export const LANGS = ['en', 'tr', ...Object.keys(more)];
export default more;
