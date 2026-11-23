import Names from '../../../www/js/names.js';
import '../../../www/js/names/de.js';

const name = seed => Names.text(seed, 'de');
const num = n => n.toLocaleString('de-DE');

export default {
  invite: v => ['Einladung an einen Tisch', name(v.seed) + ' hat dich an einen Tisch eingeladen.'],
  req: v => ['Freundschaftsanfrage', name(v.seed) + ' hat dir eine Freundschaftsanfrage geschickt.'],
  accept: v => ['Neuer Freund', name(v.seed) + ' hat deine Freundschaftsanfrage angenommen.'],
  dm: v => ['Neue Nachricht', name(v.seed) + ' hat dir eine Nachricht geschickt.'],
  daily: v => ['Tagesbonus', 'Dein Tagesbonus von ' + num(v.n) + ' Chips wartet auf dich.'],
  week: v => ['Wochenrangliste', 'Letzte Woche hast du ' + num(v.won) + ' Chips gewonnen und Platz ' + v.rank + ' belegt.']
};
