// push texts for the languages beyond English and Turkish, which live in push.js
import es from './text/es.js';
import pt from './text/pt.js';
import fr from './text/fr.js';
import it from './text/it.js';
import nl from './text/nl.js';
import de from './text/de.js';
import pl from './text/pl.js';
import ru from './text/ru.js';
import uk from './text/uk.js';

const more = { es, pt, fr, it, nl, de, pl, ru, uk };

export const LANGS = ['en', 'tr', ...Object.keys(more)];
export default more;
