import Names from '../../../www/js/names.js';
import '../../../www/js/names/ru.js';

const name = seed => Names.text(seed, 'ru');
const num = n => n.toLocaleString('ru-RU');
const rules = new Intl.PluralRules('ru');
const chips = n => num(n) + ' ' + ({ one: 'фишка', few: 'фишки' }[rules.select(n)] || 'фишек');

export default {
  invite: v => ['Приглашение за стол', name(v.seed) + ' приглашает тебя за стол.'],
  req: v => ['Запрос в друзья', name(v.seed) + ' отправляет тебе запрос в друзья.'],
  accept: v => ['Новый друг', name(v.seed) + ' принимает твой запрос в друзья.'],
  dm: v => ['Новое сообщение', name(v.seed) + ' пишет тебе.'],
  daily: v => ['Ежедневный бонус', 'Тебя ждёт ежедневный бонус: ' + chips(v.n) + '.'],
  week: v => ['Таблица недели', 'Итоги прошлой недели: выиграно ' + chips(v.won) + ', место ' + v.rank + '.']
};
