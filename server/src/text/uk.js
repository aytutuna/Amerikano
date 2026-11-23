import Names from '../../../www/js/names.js';
import '../../../www/js/names/uk.js';

const name = seed => Names.text(seed, 'uk');
const num = n => n.toLocaleString('uk-UA');
const rules = new Intl.PluralRules('uk');
const chips = n => num(n) + ' ' + ({ one: 'фішка', few: 'фішки' }[rules.select(n)] || 'фішок');

export default {
  invite: v => ['Запрошення до столу', name(v.seed) + ' запрошує тебе до столу.'],
  req: v => ['Запит у друзі', name(v.seed) + ' надсилає тобі запит у друзі.'],
  accept: v => ['Новий друг', name(v.seed) + ' приймає твій запит у друзі.'],
  dm: v => ['Нове повідомлення', name(v.seed) + ' пише тобі.'],
  daily: v => ['Щоденний бонус', 'На тебе чекає щоденний бонус: ' + chips(v.n) + '.'],
  week: v => ['Таблиця тижня', 'Підсумки минулого тижня: виграно ' + chips(v.won) + ', місце ' + v.rank + '.']
};
