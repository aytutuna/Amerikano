import Names from '../../../www/js/names.js';
import '../../../www/js/names/pt.js';

const name = seed => Names.text(seed, 'pt');
const num = n => n.toLocaleString('pt-BR');

export default {
  invite: v => ['Convite para uma mesa', name(v.seed) + ' convidou você para uma mesa.'],
  req: v => ['Pedido de amizade', name(v.seed) + ' enviou um pedido de amizade para você.'],
  accept: v => ['Novo amigo', name(v.seed) + ' aceitou seu pedido de amizade.'],
  dm: v => ['Nova mensagem', name(v.seed) + ' enviou uma mensagem para você.'],
  daily: v => ['Bônus diário', 'Seu bônus diário de ' + num(v.n) + ' fichas já está pronto.'],
  week: v => ['Ranking semanal', 'Na semana passada você ganhou ' + num(v.won) + ' fichas e ficou em ' + v.rank + 'º lugar.']
};
