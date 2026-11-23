import Names from '../../../www/js/names.js';
import '../../../www/js/names/nl.js';

const name = seed => Names.text(seed, 'nl');
const num = n => n.toLocaleString('nl-NL');

export default {
  invite: v => ['Uitnodiging voor een tafel', name(v.seed) + ' heeft je uitgenodigd voor een tafel.'],
  req: v => ['Vriendschapsverzoek', name(v.seed) + ' heeft je een vriendschapsverzoek gestuurd.'],
  accept: v => ['Nieuwe vriend', name(v.seed) + ' heeft je vriendschapsverzoek geaccepteerd.'],
  dm: v => ['Nieuw bericht', name(v.seed) + ' heeft je een bericht gestuurd.'],
  daily: v => ['Dagelijkse bonus', 'Je dagelijkse bonus van ' + num(v.n) + ' fiches staat klaar.'],
  week: v => ['Weekranglijst', 'Vorige week won je ' + num(v.won) + ' fiches en eindigde je op plek ' + v.rank + '.']
};
