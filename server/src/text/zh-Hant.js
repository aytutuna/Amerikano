import Names from '../../../www/js/names.js';
import '../../../www/js/names/zh-Hant.js';

const name = seed => Names.text(seed, 'zh-Hant');
const num = n => n.toLocaleString('zh-TW');

export default {
  invite: v => ['牌桌邀請', name(v.seed) + '邀請你加入牌桌。'],
  req: v => ['好友邀請', name(v.seed) + '向你送出了好友邀請。'],
  accept: v => ['新好友', name(v.seed) + '接受了你的好友邀請。'],
  dm: v => ['新訊息', name(v.seed) + '傳了一則訊息給你。'],
  daily: v => ['每日獎勵', '你的' + num(v.n) + '籌碼每日獎勵可以領取了。'],
  week: v => ['週排行榜', '上週你贏得了' + num(v.won) + '籌碼，排名第' + v.rank + '名。']
};
