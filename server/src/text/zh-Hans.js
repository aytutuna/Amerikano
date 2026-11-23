import Names from '../../../www/js/names.js';
import '../../../www/js/names/zh-Hans.js';

const name = seed => Names.text(seed, 'zh-Hans');
const num = n => n.toLocaleString('zh-CN');

export default {
  invite: v => ['牌桌邀请', name(v.seed) + '邀请你加入牌桌。'],
  req: v => ['好友申请', name(v.seed) + '向你发来了好友申请。'],
  accept: v => ['新好友', name(v.seed) + '接受了你的好友申请。'],
  dm: v => ['新消息', name(v.seed) + '给你发了一条消息。'],
  daily: v => ['每日奖励', '你的' + num(v.n) + '金币每日奖励可以领取了。'],
  week: v => ['周榜', '上周你赢得了' + num(v.won) + '金币，排名第' + v.rank + '名。']
};
