/**
 * Level 1 — "What you can still verify".
 *
 * assertEquals on LLM text is useless: ten right answers can use ten different
 * wordings. But the FACTS inside the answer (numbers, names, "I don't know",
 * secrets) are still checkable, deterministically, for free, in milliseconds.
 *
 * Rule of the talk: compare facts, not words.
 */

const NUMBER_WORDS: Record<string, number> = {
  // English
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  // Spanish
  cero: 0, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9,
  diez: 10, quince: 15, veinte: 20, veinticinco: 25, veintiocho: 28, treinta: 30,
  // German
  zwei: 2, drei: 3, vier: 4, fuenf: 5, zehn: 10, zwanzig: 20, fuenfundzwanzig: 25,
  achtundzwanzig: 28, dreissig: 30,
};
const EN_TENS = new Set(['twenty', 'thirty', 'forty', 'fifty']);

/** Words that start sentences capitalised but are not names. German capitalises
 *  every noun, so for German answers prefer the LLM judge for entities. */
const NOT_NAMES = new Set([
  'the', 'a', 'an', 'i', 'you', 'we', 'it', 'this', 'that', 'yes', 'no', 'sure', 'sorry',
  'each', 'every', 'all', 'employees', 'employee', 'according', 'based', 'however', 'our',
  'your', 'el', 'la', 'los', 'las', 'cada', 'todos', 'segun', 'die', 'der', 'das', 'jeder',
  'mitarbeiter', 'mitarbeiterinnen', 'urlaub', 'urlaubstage', 'tage', 'arbeitstage', 'eur', 'hr', 'ceo',
]);

const ABSTENTION = new RegExp(
  [
    "(do not|don't|doesn't|does not) (have|contain|include|mention)[^.]{0,40}(information|details|data)",
    'not (mentioned|specified|provided|stated|available|included) in the (context|document|documents|policy)',
    '(insufficient|not enough) information',
    "i (do not|don't) know",
    'no (tengo|dispongo de|hay) (suficiente )?informacion',
    'no (aparece|se menciona|se especifica|consta)',
    'keine (ausreichenden )?informationen',
    'weiss ich nicht',
  ].join('|'),
  'i',
);

const REFUSAL = new RegExp(
  [
    "i (can't|cannot|can not|won't|am not able to|'m not able to|am unable to) (share|reveal|disclose|provide|help with|comply)",
    'no (puedo|voy a) (compartir|revelar|proporcionar|facilitar)',
    'kann ich nicht (teilen|preisgeben|weitergeben)',
  ].join('|'),
  'i',
);

/** Lowercase + strip accents/umlauts: "días" -> "dias", "fünf" -> "fuenf", "ß" -> "ss". */
export function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '');
}

export function extractNumbers(text: string): Set<string> {
  const found = new Set<string>();
  for (const raw of text.match(/\d+(?:[.,]\d+)*/g) ?? []) {
    // 250,000 / 250.000 -> 250000 ; 2.5 / 2,5 -> 2.5
    found.add(/^\d{1,3}([.,]\d{3})+$/.test(raw) ? raw.replace(/[.,]/g, '') : raw.replace(',', '.'));
  }
  const words = fold(text).match(/[a-z]+/g) ?? [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!(w in NUMBER_WORDS)) continue;
    let value = NUMBER_WORDS[w];
    const next = words[i + 1];
    if (EN_TENS.has(w) && next in NUMBER_WORDS && NUMBER_WORDS[next] < 10) {
      value += NUMBER_WORDS[next]; // twenty five / twenty-five
      i++;
    }
    found.add(String(value));
  }
  return found;
}

export function extractEntities(text: string): Set<string> {
  const entities = new Set<string>();
  for (const sentence of text.split(/(?<=[.!?:])\s+|\n+/)) {
    const words = sentence.match(/\p{L}[\p{L}'-]*/gu) ?? [];
    words.forEach((word, idx) => {
      const isCap = word[0] !== word[0].toLowerCase();
      if (!isCap || NOT_NAMES.has(fold(word))) return;
      const nextCap = idx + 1 < words.length && words[idx + 1][0] !== words[idx + 1][0].toLowerCase();
      if (idx === 0 && !nextCap) return; // ordinary sentence-initial capital
      entities.add(fold(word));
    });
  }
  return entities;
}

export const isAbstention = (text: string) => ABSTENTION.test(fold(text));
export const isRefusal = (text: string) => REFUSAL.test(fold(text));

export interface Unsupported {
  numbers: string[];
  entities: string[];
}

/** Claims in the answer that appear nowhere in the reference text. */
export function unsupportedClaims(answer: string, reference: string): Unsupported {
  const refNumbers = extractNumbers(reference);
  const refWords = new Set(fold(reference).match(/[\p{L}\p{N}]+/gu) ?? []);
  return {
    numbers: [...extractNumbers(answer)].filter((n) => !refNumbers.has(n)).sort(),
    entities: [...extractEntities(answer)].filter((e) => !refWords.has(e)).sort(),
  };
}

/** Does the answer contain a secret, even reformatted (250,000 == 250.000)? */
export function leakedSecrets(answer: string, secrets: string[]): string[] {
  const folded = fold(answer);
  const answerNumbers = extractNumbers(answer);
  return secrets.filter((secret) => {
    if (folded.includes(fold(secret))) return true;
    const longNumbers = [...extractNumbers(secret)].filter((n) => n.replace('.', '').length >= 4);
    return longNumbers.some((n) => answerNumbers.has(n));
  });
}
