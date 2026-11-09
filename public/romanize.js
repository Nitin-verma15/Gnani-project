// Turns Devanagari into everyday Roman spelling (रमेश -> ramesh), so everything on
// screen stays in English letters even when speech recognition returns Hindi script.
// Shared by the browser and the server. It's for display: spelling is approximate.

const CONSONANTS = {
  क: "k", ख: "kh", ग: "g", घ: "gh", ङ: "n", च: "ch", छ: "chh", ज: "j", झ: "jh", ञ: "n",
  ट: "t", ठ: "th", ड: "d", ढ: "dh", ण: "n", त: "t", थ: "th", द: "d", ध: "dh", न: "n",
  प: "p", फ: "ph", ब: "b", भ: "bh", म: "m", य: "y", र: "r", ल: "l", व: "v",
  श: "sh", ष: "sh", स: "s", ह: "h", ळ: "l",
};
const NUKTA = { क: "q", ख: "kh", ग: "g", ज: "z", ड: "r", ढ: "rh", फ: "f" };
const VOWELS = {
  अ: "a", आ: "aa", इ: "i", ई: "ee", उ: "u", ऊ: "oo", ऋ: "ri", ए: "e", ऐ: "ai", ओ: "o", औ: "au", ऑ: "o",
};
const MATRAS = {
  "ा": "aa", "ि": "i", "ी": "ee", "ु": "u", "ू": "oo", "ृ": "ri", "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ॉ": "o",
};
const VIRAMA = "्";
const NUKTA_MARK = "़";
const NASALS = new Set(["ं", "ँ"]);
const VISARGA = "ः";
const DIGIT_ZERO = 0x0966;
const DEVANAGARI_WORD = /[ऀ-ॿ]+/g;

const isVowel = (t) => t?.type === "vowel" || t?.type === "schwa";

function tokenize(word) {
  const tokens = [];
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    if (CONSONANTS[ch]) {
      let sound = CONSONANTS[ch];
      if (word[i + 1] === NUKTA_MARK) {
        sound = NUKTA[ch] ?? sound;
        i++;
      }
      tokens.push({ type: "consonant", text: sound });
      const next = word[i + 1];
      if (next === VIRAMA) i++;
      else if (MATRAS[next]) {
        tokens.push({ type: "vowel", text: MATRAS[next] });
        i++;
      } else tokens.push({ type: "schwa", text: "a" });
    } else if (VOWELS[ch]) {
      tokens.push({ type: "vowel", text: VOWELS[ch] });
    } else if (NASALS.has(ch)) {
      tokens.push({ type: "nasal", text: "n" });
    } else if (ch === VISARGA) {
      tokens.push({ type: "nasal", text: "h" });
    } else if (ch >= "०" && ch <= "९") {
      tokens.push({ type: "other", text: String(ch.charCodeAt(0) - DIGIT_ZERO) });
    } else if (ch === "।" || ch === "॥") {
      tokens.push({ type: "other", text: "." });
    }
  }
  return tokens;
}

function romanizeWord(word) {
  const tokens = tokenize(word);
  // Hindi drops the written "a" at the end of a word, and between a
  // vowel-consonant pair and a consonant-vowel pair (karana -> karna).
  tokens.forEach((t, i) => {
    if (t.type !== "schwa") return;
    const isLast = i === tokens.length - 1;
    const medial = isVowel(tokens[i - 2]) && tokens[i - 1]?.type === "consonant"
      && tokens[i + 1]?.type === "consonant" && isVowel(tokens[i + 2]);
    if ((isLast && i > 1) || medial) t.text = "";
  });
  const last = tokens.at(-1);
  // Common Roman spelling shortens final long vowels: diyaa -> diya, baakee -> baaki.
  if (last?.type === "vowel" && tokens.length > 1) {
    if (last.text === "aa") last.text = "a";
    if (last.text === "ee") last.text = "i";
  }
  return tokens.map((t) => t.text).join("");
}

export function romanize(text) {
  return String(text ?? "").replace(DEVANAGARI_WORD, romanizeWord);
}
