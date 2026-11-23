import Names from '../../../www/js/names.js';
import '../../../www/js/names/ja.js';

const name = seed => Names.text(seed, 'ja');
const num = n => n.toLocaleString('ja-JP');

export default {
  invite: v => ['テーブルへの招待', name(v.seed) + 'さんからテーブルに招待されました。'],
  req: v => ['フレンド申請', name(v.seed) + 'さんからフレンド申請が届きました。'],
  accept: v => ['新しいフレンド', name(v.seed) + 'さんがフレンド申請を承認しました。'],
  dm: v => ['新着メッセージ', name(v.seed) + 'さんからメッセージが届きました。'],
  daily: v => ['デイリーボーナス', 'デイリーボーナス' + num(v.n) + 'チップを受け取れます。'],
  week: v => ['週間ランキング', '先週は' + num(v.won) + 'チップを獲得し、' + v.rank + '位でした。']
};
