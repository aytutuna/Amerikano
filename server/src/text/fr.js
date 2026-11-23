import Names from '../../../www/js/names.js';
import '../../../www/js/names/fr.js';

const name = seed => Names.text(seed, 'fr');
const num = n => n.toLocaleString('fr-FR');
const rank = n => n === 1 ? '1er' : n + 'e';

export default {
  invite: v => ['Invitation à une table', name(v.seed) + ' t’a invité à une table.'],
  req: v => ['Demande d’ami', name(v.seed) + ' t’a envoyé une demande d’ami.'],
  accept: v => ['Nouvel ami', name(v.seed) + ' a accepté ta demande d’ami.'],
  dm: v => ['Nouveau message', name(v.seed) + ' t’a envoyé un message.'],
  daily: v => ['Bonus quotidien', 'Ton bonus quotidien de ' + num(v.n) + ' jetons t’attend.'],
  week: v => ['Classement hebdo', 'La semaine dernière, tu as gagné ' + num(v.won) + ' jetons et tu finis ' + rank(v.rank) + '.']
};
