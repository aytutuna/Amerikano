import Names from '../../../www/js/names.js';
import '../../../www/js/names/pl.js';

const name = seed => Names.text(seed, 'pl');
const num = n => n.toLocaleString('pl-PL');
const rules = new Intl.PluralRules('pl');
const chips = n => num(n) + ' ' + ({ one: 'żeton', few: 'żetony' }[rules.select(n)] || 'żetonów');

export default {
  invite: v => ['Zaproszenie do stołu', name(v.seed) + ' zaprasza cię do stołu.'],
  req: v => ['Zaproszenie do znajomych', name(v.seed) + ' wysyła ci zaproszenie do znajomych.'],
  accept: v => ['Nowy znajomy', name(v.seed) + ' przyjmuje twoje zaproszenie do znajomych.'],
  dm: v => ['Nowa wiadomość', name(v.seed) + ' wysyła ci wiadomość.'],
  daily: v => ['Bonus dzienny', 'Czeka na ciebie dzienny bonus: ' + chips(v.n) + '.'],
  week: v => ['Ranking tygodnia', 'W zeszłym tygodniu wygrane żetony: ' + num(v.won) + '. Twoje miejsce: ' + v.rank + '.']
};
