// push texts for the languages beyond English and Turkish, which live in push.js
import es from './text/es.js';
import pt from './text/pt.js';
import fr from './text/fr.js';
import it from './text/it.js';

const more = { es, pt, fr, it };

export const LANGS = ['en', 'tr', ...Object.keys(more)];
export default more;
