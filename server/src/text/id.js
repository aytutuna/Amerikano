import Names from '../../../www/js/names.js';
import '../../../www/js/names/id.js';

const name = seed => Names.text(seed, 'id');
const num = n => n.toLocaleString('id-ID');

export default {
  invite: v => ['Undangan meja', name(v.seed) + ' mengundangmu ke sebuah meja.'],
  req: v => ['Permintaan pertemanan', name(v.seed) + ' mengirim permintaan pertemanan.'],
  accept: v => ['Teman baru', name(v.seed) + ' menerima permintaan pertemananmu.'],
  dm: v => ['Pesan baru', name(v.seed) + ' mengirim pesan untukmu.'],
  daily: v => ['Bonus harian', 'Bonus harianmu sebesar ' + num(v.n) + ' chip sudah siap.'],
  week: v => ['Papan peringkat mingguan', 'Minggu lalu kamu mendapat ' + num(v.won) + ' chip dan berada di peringkat ' + v.rank + '.']
};
