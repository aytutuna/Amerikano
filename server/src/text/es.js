import Names from '../../../www/js/names.js';
import '../../../www/js/names/es.js';

const name = seed => Names.text(seed, 'es');
const num = n => n.toLocaleString('es-419');

export default {
  invite: v => ['Invitación a una mesa', name(v.seed) + ' te invitó a una mesa.'],
  req: v => ['Solicitud de amistad', name(v.seed) + ' te envió una solicitud de amistad.'],
  accept: v => ['Nuevo amigo', name(v.seed) + ' aceptó tu solicitud de amistad.'],
  dm: v => ['Mensaje nuevo', name(v.seed) + ' te envió un mensaje.'],
  daily: v => ['Bono diario', 'Tu bono diario de ' + num(v.n) + ' fichas ya está listo.'],
  week: v => ['Tabla semanal', 'La semana pasada ganaste ' + num(v.won) + ' fichas y quedaste en el lugar ' + v.rank + '.']
};
