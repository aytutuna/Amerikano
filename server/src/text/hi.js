import Names from '../../../www/js/names.js';
import '../../../www/js/names/hi.js';

const name = seed => Names.text(seed, 'hi');
const num = n => n.toLocaleString('hi-IN');

export default {
  invite: v => ['टेबल का न्योता', name(v.seed) + ' ने आपको टेबल पर बुलाया है।'],
  req: v => ['दोस्ती का अनुरोध', name(v.seed) + ' ने आपको दोस्ती का अनुरोध भेजा है।'],
  accept: v => ['नया दोस्त', name(v.seed) + ' ने आपका दोस्ती का अनुरोध स्वीकार कर लिया।'],
  dm: v => ['नया मैसेज', name(v.seed) + ' ने आपको मैसेज भेजा है।'],
  daily: v => ['रोज़ का बोनस', 'आपके ' + num(v.n) + ' चिप्स का रोज़ का बोनस तैयार है।'],
  week: v => ['हफ़्ते की रैंकिंग', 'पिछले हफ़्ते आपने ' + num(v.won) + ' चिप्स जीते और स्थान ' + v.rank + ' पर रहे।']
};
