var Chat = (function () {
  const SAY = ['hello', 'luck', 'nice', 'thanks', 'oops', 'hurry', 'wow', 'close', 'sorry', 'rematch', 'well', 'bye'];
  const EMO = ['smile', 'laugh', 'wink', 'love', 'gasp', 'sad', 'angry', 'cheer'];
  const GIFTS = [{ k: 'tea', cost: 50 }, { k: 'sweet', cost: 200 }, { k: 'rose', cost: 1000 }, { k: 'crown', cost: 5000 }];

  return { SAY: SAY, EMO: EMO, GIFTS: GIFTS };
})();

if (typeof module !== 'undefined') module.exports = Chat;
