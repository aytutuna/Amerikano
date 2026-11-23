import Names from '../../../www/js/names.js';
import '../../../www/js/names/ko.js';

const name = seed => Names.text(seed, 'ko');
const num = n => n.toLocaleString('ko-KR');

export default {
  invite: v => ['테이블 초대', name(v.seed) + ' 님이 테이블에 초대했어요.'],
  req: v => ['친구 요청', name(v.seed) + ' 님이 친구 요청을 보냈어요.'],
  accept: v => ['새 친구', name(v.seed) + ' 님이 친구 요청을 수락했어요.'],
  dm: v => ['새 메시지', name(v.seed) + ' 님이 메시지를 보냈어요.'],
  daily: v => ['일일 보너스', '일일 보너스 칩 ' + num(v.n) + '개를 받을 수 있어요.'],
  week: v => ['주간 랭킹', '지난주에 칩 ' + num(v.won) + '개를 따서 ' + v.rank + '위를 했어요.']
};
