import Names from '../../../www/js/names.js';
import '../../../www/js/names/ar.js';

const name = seed => Names.text(seed, 'ar');
const num = n => n.toLocaleString('ar-u-nu-latn');

export default {
  invite: v => ['دعوة إلى طاولة', 'دعاك ' + name(v.seed) + ' إلى طاولة.'],
  req: v => ['طلب صداقة', 'أرسل لك ' + name(v.seed) + ' طلب صداقة.'],
  accept: v => ['صديق جديد', 'قبل ' + name(v.seed) + ' طلب صداقتك.'],
  dm: v => ['رسالة جديدة', 'أرسل لك ' + name(v.seed) + ' رسالة.'],
  daily: v => ['المكافأة اليومية', 'مكافأتك اليومية البالغة ' + num(v.n) + ' رقاقة جاهزة.'],
  week: v => ['ترتيب الأسبوع', 'ربحت الأسبوع الماضي ' + num(v.won) + ' رقاقة وجاء ترتيبك ' + v.rank + '.']
};
