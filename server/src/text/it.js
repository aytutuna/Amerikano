import Names from '../../../www/js/names.js';
import '../../../www/js/names/it.js';

const name = seed => Names.text(seed, 'it');
const num = n => n.toLocaleString('it-IT');

export default {
  invite: v => ['Invito a un tavolo', name(v.seed) + ' ti ha invitato a un tavolo.'],
  req: v => ['Richiesta di amicizia', name(v.seed) + ' ti ha mandato una richiesta di amicizia.'],
  accept: v => ['Nuovo amico', name(v.seed) + ' ha accettato la tua richiesta di amicizia.'],
  dm: v => ['Nuovo messaggio', name(v.seed) + ' ti ha mandato un messaggio.'],
  daily: v => ['Bonus giornaliero', 'Il tuo bonus giornaliero da ' + num(v.n) + ' fiches è pronto.'],
  week: v => ['Classifica settimanale', 'La settimana scorsa hai vinto ' + num(v.won) + ' fiches. Posizione in classifica: ' + v.rank + '.']
};
